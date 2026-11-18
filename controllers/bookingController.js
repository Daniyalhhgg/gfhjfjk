const mongoose = require("mongoose");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const Booking = require("../models/Booking");
const WeddingBooking = require("../models/WeddingBooking");
const Chat = require("../models/Chat");
const Reminder = require("../models/Reminder");
const Setting = require("../models/Setting");
const Menu = require("../models/Menu");
const menuCategoryForPackage = require("../utils/menuCategory");
const { checkAvailability, timeToMinutes } = require("../services/availabilityService");
const { getRoomAvailability, dateObject: roomDateObject } = require("../services/roomAvailabilityService");
const { scheduleJob, cancelJob } = require("../services/reminderQueue");
const { parseReminderDateTime } = require("../utils/dateParser");
const { publishDashboardNotification } = require("../services/dashboardNotificationService");
const { getSupportSettings, isSupportTypeAvailable } = require("../services/supportSettings");
const { buildCustomerCancellationMessage } = require("../services/bookingCancellation");
const { sendWhatsAppText: sendWhatsAppTextService } = require("../services/whatsappText");
const {
  getBookingPaymentPolicy,
  getBookingPaymentPolicyForCategory,
  calculateAdvanceAmount,
  setPaymentDeadline,
} = require("../services/bookingPaymentPolicy");

const DEFAULT_PAYMENT_BANK_NAME = "Meezan Bank";

const cleanEnvValue = (value) => String(value ?? "")
  .replace(/^\uFEFF/, "")
  .trim()
  .replace(/^['"]+|['"]+$/g, "")
  .trim();

const readEnv = (name) => {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    return cleanEnvValue(process.env[name]);
  }
  const match = Object.keys(process.env).find((key) => key.trim() === name);
  return match ? cleanEnvValue(process.env[match]) : "";
};

// Whole-value placeholders only (e.g. "CONFIGURE ACCOUNT TITLE", "set_me").
// Do not scan real titles/numbers for the substrings "configure", "placeholder", or "set_".
const isPlaceholderValue = (value) => {
  const v = cleanEnvValue(value);
  if (!v) return true;
  return /^(?:<(?:configure|placeholder|set_[a-z0-9_]+|[^>]+)>|(?:please\s+)?(?:configure|placeholder|changeme|todo|xxx+)(?:[\s_-]+[a-z0-9]+)*|set_[a-z0-9_]+)$/i.test(v);
};

const envPresence = (name) => {
  const value = readEnv(name);
  if (!value) return "missing";
  return isPlaceholderValue(value) ? "set (placeholder)" : "set";
};

const logPaymentEnvStatus = (context = "call") => {
  const title = readEnv("PAYMENT_ACCOUNT_TITLE");
  const number = readEnv("PAYMENT_ACCOUNT_NUMBER");
  const iban = readEnv("PAYMENT_IBAN");
  const titleOk = Boolean(title) && !isPlaceholderValue(title);
  const numberOk = Boolean(number) && !isPlaceholderValue(number);
  const ibanOk = Boolean(iban) && !isPlaceholderValue(iban);
  const configured = Boolean(titleOk && (numberOk || ibanOk));
  console.log(
    `[payment env ${context}] PAYMENT_ACCOUNT_TITLE: ${envPresence("PAYMENT_ACCOUNT_TITLE")}, PAYMENT_ACCOUNT_NUMBER: ${envPresence("PAYMENT_ACCOUNT_NUMBER")}, PAYMENT_IBAN: ${envPresence("PAYMENT_IBAN")}, PAYMENT_BANK_NAME: ${envPresence("PAYMENT_BANK_NAME")}, configured: ${configured}`
  );
  return configured;
};

const unconfiguredPayment = (booking) => ({
  configured: false,
  bankName: readEnv("PAYMENT_BANK_NAME") || DEFAULT_PAYMENT_BANK_NAME,
  accountTitle: "",
  accountNumber: "",
  iban: "",
  advanceAmount: booking && Number.isFinite(Number(booking.advanceAmount)) ? Number(booking.advanceAmount) : null,
  advancePercent: booking && Number.isFinite(Number(booking.advancePercent)) ? Number(booking.advancePercent) : 20,
  message: "Payment account is not configured.",
});

const paymentInstructions = (booking) => {
  try {
    const advanceAmount = booking && Number.isFinite(Number(booking.advanceAmount))
      ? Number(booking.advanceAmount)
      : null;
    const advancePercent = booking && Number.isFinite(Number(booking.advancePercent))
      ? Number(booking.advancePercent)
      : 20;
    if (advancePercent === 0) {
      return {
        configured: true,
        required: false,
        bankName: "",
        accountTitle: "",
        accountNumber: "",
        iban: "",
        advanceAmount: 0,
        advancePercent: 0,
        message: "No advance payment is required. The booking remains pending until staff confirms it.",
      };
    }

    const accountTitle = readEnv("PAYMENT_ACCOUNT_TITLE");
    const accountNumber = readEnv("PAYMENT_ACCOUNT_NUMBER");
    const iban = readEnv("PAYMENT_IBAN");
    const bankName = readEnv("PAYMENT_BANK_NAME") || DEFAULT_PAYMENT_BANK_NAME;
    const titleOk = Boolean(accountTitle) && !isPlaceholderValue(accountTitle);
    const numberOk = Boolean(accountNumber) && !isPlaceholderValue(accountNumber);
    const ibanOk = Boolean(iban) && !isPlaceholderValue(iban);
    const configured = Boolean(titleOk && (numberOk || ibanOk));
    logPaymentEnvStatus(booking?._id ? `booking ${booking._id}` : "call");

    const lines = [
      bankName ? `Bank: ${bankName}` : "",
      titleOk ? `Account title: ${accountTitle}` : "",
      numberOk ? `Account number: ${accountNumber}` : "",
      ibanOk ? `IBAN: ${iban}` : "",
      advanceAmount != null ? `Advance (${advancePercent}%): ${moneyPk(advanceAmount)}` : "",
    ].filter(Boolean);
    const message = configured
      ? `Please pay the ${advancePercent}% advance using these company account details:\n${lines.join("\n")}\nAfter payment, send the screenshot on this WhatsApp chat.`
      : "Payment account is not configured.";

    return {
      configured,
      bankName,
      accountTitle: titleOk ? accountTitle : "",
      accountNumber: numberOk ? accountNumber : "",
      iban: ibanOk ? iban : "",
      advanceAmount,
      advancePercent,
      required: true,
      message,
    };
  } catch (error) {
    console.error("paymentInstructions() failed:", error.message);
    return unconfiguredPayment(booking);
  }
};

logPaymentEnvStatus("startup");

const notifyDashboard = (req, booking, event, title, message) => publishDashboardNotification(req, {
  restaurantId: booking.restaurantId,
  sourceKey: `${event}:${booking._id}:${booking.updatedAt?.getTime() || Date.now()}`,
  type: event,
  title,
  message,
  entityType: "booking",
  entityId: String(booking._id),
}).catch((error) => console.error(`Dashboard ${event} notification failed:`, error));

const emitBooking = (req, event, booking) => {
  const io = req.app.get("io");
  if (event === "new_booking") {
    const packageName = booking.package || booking.selectedMenuName || "Booking";
    void notifyDashboard(req, booking, "new_booking", "New booking received", `${booking.customerName || "Customer"} · ${packageName}`);
  }
  if (!io) return;
  if (event === "new_booking") {
    io.to("chat-admins").emit(event, {
      type: "NEW_BOOKING",
      data: booking,
      bookingId: booking._id,
      restaurantId: booking.restaurantId,
      booking,
    });
    return;
  }
  io.to("chat-admins").emit(event, { bookingId: booking._id, restaurantId: booking.restaurantId, booking });
};
const timeString = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const formatPkDate = (value) => {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-PK", {
    timeZone: process.env.SLOT_TIMEZONE || "Asia/Karachi",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
};
const moneyPk = (value) => `Rs ${Number(value || 0).toLocaleString("en-PK")}`;
const digitsOnly = (value) => String(value || "").replace(/\D/g, "");
const detectLanguage = (text, fallback = "en") => {
  const source = String(text || "");
  if ([...source].some((character) => {
    const code = character.codePointAt(0);
    return code >= 1536 && code <= 1791;
  })) return "ur";
  if (/\b(hai|hain|kya|kar|karo|chahiye|mujhe|aap|apko|aapki|aapka|mein|main|nahi|bhi|ka|ki|ke|ko|se|mera|meri|bata|bhej|karein|raha|rahi|theek|han|haan|ji|shukriya)\b/i.test(source)) return "roman";
  return fallback || "en";
};
const bookingDetailLines = (booking) => [
  `Package: ${booking.package || "Not recorded"}`,
  booking.bookingCategory ? `Category: ${booking.bookingCategory}` : "",
  ...(booking.selectedItems || []).map((item) => `Item: ${item.name}${item.quantity > 1 ? ` x${item.quantity}` : ""}`),
  ...(booking.bookingDetails || []).map((detail) => `${detail.label}: ${detail.value}`),
  booking.roomType ? `Room type: ${booking.roomType}` : "",
  booking.roomType ? `Rooms: ${booking.numberOfRooms || 1}` : "",
  booking.roomType ? `Check-in: ${formatPkDate(booking.bookingDate)}` : `Date: ${formatPkDate(booking.bookingDate)}`,
  booking.checkOutDate ? `Check-out: ${formatPkDate(booking.checkOutDate)}` : "",
  booking.roomType ? "" : `Time: ${booking.bookingTime || "Not recorded"}`,
  `Guests: ${booking.numberOfPersons || "Not recorded"}`,
  booking.specialRequests ? `Special requests: ${booking.specialRequests}` : "",
].filter(Boolean);
const bookingConfirmationText = (booking) => {
  const language = booking.customerLanguage || "en";
  const noAdvance = Number(booking.advancePercent ?? 20) === 0;
  const intro = noAdvance
    ? language === "ur"
      ? `محترم/محترمہ ${booking.customerName}،\n\nآپ کی بکنگ عملے کی تصدیق کے بعد کنفرم ہے؛ اس بکنگ کے لیے ایڈوانس درکار نہیں تھا۔`
      : language === "roman"
        ? `Dear ${booking.customerName},\n\nStaff review ke baad aapki booking confirm hai; is booking ke liye advance required nahi tha.`
        : `Dear ${booking.customerName},\n\nYour booking is confirmed after staff review; no advance payment was required.`
    : language === "ur"
      ? `محترم/محترمہ ${booking.customerName}،\n\nآپ کی ادائیگی موصول ہو گئی ہے اور تصدیق ہو گئی ہے۔ آپ کی بکنگ کنفرم ہے۔`
      : language === "roman"
        ? `Dear ${booking.customerName},\n\nAapki payment receive ho gayi hai aur verify ho gayi hai. Aapki booking confirm hai.`
        : `Dear ${booking.customerName},\n\nYour payment has been received and verified. Your booking is confirmed.`;
  return [
    intro,
    "",
    ...bookingDetailLines(booking),
    `Total bill: ${moneyPk(booking.totalAmount)}`,
    noAdvance ? "Advance required: Rs 0" : `Advance received: ${moneyPk(booking.advanceAmount)}`,
    "",
    language === "ur" ? "Hotel d'GATES کا شکریہ۔" : language === "roman" ? "Hotel d'GATES ka shukriya." : "Thank you for choosing Hotel d'GATES.",
  ].join("\n");
};
const customerWaitText = (language) => {
  if (language === "ur") return "ٹھیک ہے، ہمارے ساتھ جڑے رہیں۔ ہماری ٹیم 1 سے 5 منٹ میں ادائیگی کی تصدیق کر کے آپ کو کنفرم کر دے گی۔";
  if (language === "roman") return "Theek hai, hamare sath jude rahiye. Hamari team 1 se 5 minutes mein payment verify karke aapko confirm kar degi.";
  return "Please stay with us. Our team will verify the payment in 1 to 5 minutes and confirm it to you.";
};
const customerCsNotifyFailureText = (language) => {
  if (language === "ur") return "آپ کی تفصیلات محفوظ ہیں، لیکن ہم اس وقت ٹیم کو خودکار اطلاع نہیں دے سکے۔ براہ کرم کسٹمر سروس سے رابطہ کریں؛ ادائیگی ابھی تصدیق شدہ نہیں ہے۔";
  if (language === "roman") return "Aapki details save hain, lekin team ko automatic notification nahi ja saki. Barah-e-karam customer service se rabta karein; payment abhi verify nahi hui.";
  return "Your details are saved, but we could not notify the team automatically. Please contact customer service; your payment is not verified yet.";
};
const proofReceivedText = (language) => {
  if (language === "ur") return "آپ کی ادائیگی کا ثبوت موصول ہو گیا ہے۔ ہماری ٹیم تصدیق کر رہی ہے، براہِ کرم تھوڑا انتظار کریں۔ تصدیق ہوتے ہی آپ کو کنفرمیشن مل جائے گی۔";
  if (language === "roman") return "Aapka payment proof mil gaya hai. Hamari team verify kar rahi hai, please thora wait karein. Verify hote hi aapko confirmation mil jayegi.";
  return "Your payment proof has been received. Our team is verifying it, please wait a moment. You will get your confirmation as soon as it is verified.";
};
const proofSavedForSupportHoursText = (language) => {
  if (language === "ur") return "آپ کی ادائیگی کا ثبوت محفوظ ہے۔ ٹیم مقررہ سپورٹ اوقات میں اس کا جائزہ لے گی۔";
  if (language === "roman") return "Aapka payment proof save ho gaya hai. Team apne scheduled support hours mein isay review karegi.";
  return "Your payment proof is saved. The team will review it during its scheduled support hours.";
};
const updateSavedForSupportHoursText = (language) => {
  if (language === "ur") return "آپ کی تفصیلات محفوظ ہیں۔ ٹیم مقررہ سپورٹ اوقات میں ان کا جائزہ لے گی۔";
  if (language === "roman") return "Aapki details save ho gayi hain. Team scheduled support hours mein inka review karegi.";
  return "Your details are saved. The team will review them during its scheduled support hours.";
};
const proofConfirmQuestion = (language) => {
  if (language === "ur") return "کیا یہ ادائیگی کا ثبوت کنفرم ہے؟ براہ کرم ہاں یا نہیں لکھیں۔";
  if (language === "roman") return "Kya yeh payment proof confirm hai? Please Haan ya Nahi likhein.";
  return "Is this payment proof confirmed? Please reply Yes or No.";
};
async function sendWhatsAppText(to, body) {
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp Cloud API credentials are not configured.");
  }
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: digitsOnly(to),
      type: "text",
      text: { body },
    },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
}
async function notifyCsTeam({
  caption,
  mediaUrl,
  mediaType = "image",
  mediaFilename = "",
  restaurantId = "restaurant-1",
  scheduleType = "human_request",
  alertType = scheduleType,
}) {
  try {
    const settings = await getSupportSettings(restaurantId);
    const recipientType = ["payment_alert", "human_request", "booking_issue"].includes(alertType)
      ? alertType
      : "human_request";
    const effectiveScheduleType = alertType === "booking_issue" ? "booking_alert" : scheduleType;
    if (!isSupportTypeAvailable(settings, effectiveScheduleType)) return null;
    const csNumber = cleanEnvValue(settings.whatsappAlertNumbers?.[recipientType] || process.env.WHATSAPP_CS_TEAM_NUMBER);
    const phoneNumberId = cleanEnvValue(process.env.WHATSAPP_PHONE_NUMBER_ID);
    const accessToken = cleanEnvValue(process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN);
    if (!csNumber) return `Configure the ${recipientType} WhatsApp recipient in CRM Support > WhatsApp Alert Numbers.`;
    if (!phoneNumberId || !accessToken) {
      console.error("WhatsApp CS notify skipped: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN is missing after trim.");
      return "WhatsApp Cloud API credentials are not configured.";
    }
    const payload = mediaUrl
      ? {
        messaging_product: "whatsapp",
        to: digitsOnly(csNumber),
        type: mediaType,
        [mediaType]: {
          link: mediaUrl,
          ...(mediaType === "document" && mediaFilename ? { filename: mediaFilename } : {}),
          ...(["image", "video", "document"].includes(mediaType) ? { caption } : {}),
        },
      }
      : {
        messaging_product: "whatsapp",
        to: digitsOnly(csNumber),
        type: "text",
        text: { body: caption },
      };
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );
    console.info("WhatsApp CS alert accepted by Meta", {
      recipientType,
      recipientLastFour: digitsOnly(csNumber).slice(-4),
      messageId: response.data?.messages?.[0]?.id || null,
    });
    return "";
  } catch (error) {
    const meta = error.response?.data;
    console.error("WhatsApp CS notify failed:", error.message);
    if (meta) {
      console.error("Meta API error response:", JSON.stringify(meta));
    } else if (error.response) {
      console.error("WhatsApp HTTP status:", error.response.status, error.response.statusText);
    }
    return `CS WhatsApp notification failed: ${meta?.error?.message || error.message}`;
  }
}
const csPaymentCaption = (booking) => [
  "*Payment received — please verify*",
  "",
  `Customer: ${booking.customerName || "Customer"}`,
  `WhatsApp: +${digitsOnly(booking.customerPhone)}`,
  `Category: ${booking.bookingCategory || booking.package || "Booking"}`,
  `Package: ${booking.package || "Not recorded"}`,
  ...bookingDetailLines(booking).filter((line) => !line.startsWith("Package:")),
  `Total bill: ${moneyPk(booking.totalAmount)}`,
  `Advance due/received: ${moneyPk(booking.advanceAmount)}`,
  `Booking ID: ${booking._id}`,
  "",
  "Customer details are already saved on the Bookings page in this category section.",
  "Open Bookings → Pending payment verification to view the screenshot and verify.",
].join("\n");
const eventPaymentCaption = (booking, type) => [
  `*${type === "wedding" ? "Wedding" : "Corporate"} payment proof received — please verify*`,
  "",
  `Customer: ${booking.customerName || booking.answers?.contactPerson || "Customer"}`,
  `WhatsApp: +${digitsOnly(booking.customerPhone)}`,
  `Company/event: ${booking.answers?.companyName || booking.answers?.eventType || type}`,
  `Date: ${booking.acceptedAlternateDate || booking.answers?.weddingDate || booking.answers?.eventDate || "Not recorded"}`,
  `Venue: ${booking.hallName || "Not selected"}`,
  `Guests: ${booking.quotation?.guests || booking.answers?.guests || "Not recorded"}`,
  `Menu: ${booking.selectedMenuName || "Not recorded"}`,
  `Total bill: ${moneyPk(booking.quotation?.total)}`,
  `Advance due/received: ${moneyPk(booking.quotation?.advanceRequired)}`,
  `Booking ID: ${booking._id}`,
  "",
  "Customer details are saved in the matching Wedding/Corporate bookings section. Open the booking record to review the proof and verify or reject it with a reason.",
].join("\n");
const csDeclineCaption = (booking, reason) => [
  "*Advance payment not agreed*",
  "",
  `Customer: ${booking.customerName || "Customer"}`,
  `WhatsApp: +${digitsOnly(booking.customerPhone)}`,
  `Category: ${booking.bookingCategory || booking.package || "Booking"}`,
  `Package: ${booking.package || "Not recorded"}`,
  ...bookingDetailLines(booking).filter((line) => !line.startsWith("Package:")),
  `Total: ${moneyPk(booking.totalAmount)}`,
  `Advance asked: ${moneyPk(booking.advanceAmount)}`,
  `Reason: ${reason || `Customer did not agree to pay the ${booking.advancePercent || 20}% advance.`}`,
  `Booking ID: ${booking._id}`,
  "",
  "Details are already saved. Open Customer Details in CRM to handle this customer.",
].join("\n");
const requireN8nKey = (req, res) => {
  if (process.env.N8N_API_KEY && req.get("x-api-key") !== process.env.N8N_API_KEY) {
    res.status(401).json({ success: false, message: "Invalid API key" });
    return false;
  }
  return true;
};
const matchPhone = (stored, phone) => digitsOnly(stored).slice(-10) === digitsOnly(phone).slice(-10) && digitsOnly(phone).length >= 7;

async function confirmAndNotify(req, booking) {
  if (!["pending", "pending_payment_verification", "confirmed"].includes(booking.status)) {
    return { error: "Only pending bookings, or confirmed bookings with a failed WhatsApp message, can be confirmed." };
  }
  if (Number(booking.advancePercent ?? 20) > 0 && !["advance_received", "paid"].includes(booking.paymentStatus)) {
    return { error: "Verify the customer's advance payment before confirming this booking." };
  }

  if (isRoomBooking(booking)) {
    const availability = await checkBookingCapacity(booking.toObject(), booking.restaurantId, booking._id);
    if (!availability?.available) return { error: availability?.reason || "The selected room dates are no longer available." };
  }

  booking.status = "confirmed";
  booking.confirmedAt = booking.confirmedAt || new Date();
  booking.confirmedBy = booking.confirmedBy || req.admin._id;
  const message = bookingConfirmationText(booking);
  let sendError = "";
  try {
    await sendWhatsAppText(booking.customerPhone, message);
    booking.confirmationMessageStatus = "sent";
    booking.confirmationMessageError = "";
  } catch (error) {
    sendError = error.response?.data?.error?.message || error.message || "WhatsApp confirmation could not be sent.";
    booking.confirmationMessageStatus = "failed";
    booking.confirmationMessageError = sendError.slice(0, 500);
    console.error("Booking confirmed, but WhatsApp confirmation failed:", sendError);
  }

  await booking.save();
  await Chat.create({
    restaurantId: booking.restaurantId,
    customerPhone: booking.customerPhone,
    customerName: booking.customerName,
    botReply: message,
    sender: "admin",
    direction: "admin_to_customer",
    source: "booking_confirmation",
    status: sendError ? "failed" : "sent",
    isBookingRelated: true,
    bookingId: booking._id,
    metadata: sendError ? { error: sendError } : {},
  });
  const reminderWarning = await scheduleBookingReminder(booking);
  if (booking) emitBooking(req, "booking_updated", booking);
  return {
    booking,
    warning: [
      sendError ? `Booking confirmed, but its WhatsApp message failed: ${sendError}. Open Chat History and resend it in Agent mode.` : "",
      reminderWarning,
    ].filter(Boolean).join(" "),
  };
}

const availabilityCategoryForPackage = (packageName, categoryName = "") => {
  const menuCategory = categoryName || menuCategoryForPackage(packageName);
  return menuCategory === "Wedding Package" ? "Wedding" : menuCategory;
};
const isRoomBooking = (booking) =>
  availabilityCategoryForPackage(booking.package, booking.bookingCategory) === "Rooms" ||
  Boolean(booking.roomTypeId || booking.checkOutDate);
const paymentPolicyCategoryFor = (booking) => {
  if (isRoomBooking(booking)) return "Rooms";
  const category = String(booking.bookingCategory || "").trim();
  if (category === "Wedding") return "Wedding Package";
  return category || menuCategoryForPackage(booking.package) || "";
};

async function checkBookingCapacity(data, restaurantId) {
  const category = availabilityCategoryForPackage(data.package, data.bookingCategory);
  if (isRoomBooking(data)) {
    if (!Number.isInteger(Number(data.numberOfPersons)) || Number(data.numberOfPersons) < 1) {
      const error = new Error("Room bookings require a positive whole-number guest count.");
      error.status = 400;
      throw error;
    }
    const checkInDate = data.bookingDate instanceof Date
      ? data.bookingDate.toISOString().slice(0, 10)
      : String(data.bookingDate || "").slice(0, 10);
    const checkOutDate = data.checkOutDate instanceof Date
      ? data.checkOutDate.toISOString().slice(0, 10)
      : String(data.checkOutDate || "").slice(0, 10);
    if (!roomDateObject(checkInDate) || !roomDateObject(checkOutDate)) {
      const error = new Error("Room bookings require valid check-in and check-out dates.");
      error.status = 400;
      throw error;
    }
    return getRoomAvailability({
      restaurantId,
      checkInDate,
      checkOutDate,
      roomTypeId: data.roomTypeId,
      rooms: data.numberOfRooms || 1,
      guests: data.numberOfPersons,
      excludeBookingId: data._id,
    });
  }
  if (category === "Corporate" && (!data.bookingDate || !data.bookingTime)) {
    const error = new Error("Corporate bookings require a valid event date and time.");
    error.status = 400;
    throw error;
  }
  if (!category || !data.bookingDate || !data.bookingTime) return null;
  const date = new Date(data.bookingDate);
  if (Number.isNaN(date.getTime())) {
    const error = new Error("bookingDate is invalid");
    error.status = 400;
    throw error;
  }
  if (typeof data.bookingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.bookingDate) && date.toISOString().slice(0, 10) !== data.bookingDate) {
    const error = new Error("bookingDate is not a valid calendar date");
    error.status = 400;
    throw error;
  }
  const minutes = timeToMinutes(data.bookingTime);
  if (minutes === null) {
    const error = new Error("bookingTime must be a valid 24-hour or AM/PM time");
    error.status = 400;
    throw error;
  }
  if (category === "Corporate") return null;
  return checkAvailability({
    restaurantId,
    date: date.toISOString().slice(0, 10),
    time: timeString(minutes),
    persons: Number(data.numberOfPersons) || 1,
    category,
  });
}

async function scheduleBookingReminder(booking) {
  const start = new Date(booking.bookingDate);
  const mins = timeToMinutes(booking.bookingTime);
  if (Number.isNaN(start.getTime()) || mins === null) return "Reminder not scheduled: booking date/time is invalid.";
  const reminderDate = new Date(start);
  reminderDate.setUTCDate(reminderDate.getUTCDate() - 1);
  const dateString = reminderDate.toISOString().slice(0, 10);
  const time = timeString(mins);
  const reminderAt = parseReminderDateTime(dateString, time);
  if (reminderAt <= new Date()) return "Reminder not scheduled: booking is less than one day away.";
  const existing = await Reminder.findOne({ bookingId: booking._id, status: "pending" });
  if (existing) {
    await cancelJob(existing.jobId);
    existing.status = "cancelled";
    await existing.save();
  }
  const reminder = await Reminder.create({
    bookingId: booking._id,
    fromNumber: String(booking.customerPhone).replace(/\D/g, ""),
    restaurantId: booking.restaurantId,
    customerName: booking.customerName,
    reason: "booking_later",
    reminderDate: dateString,
    reminderTime: time,
    reminderAt,
    customerMessage: `Reminder: your ${booking.package} booking is tomorrow at ${booking.bookingTime}. We look forward to welcoming you to Hotel d'GATES.`,
    source: "booking_confirmation",
  });
  try {
    const job = await scheduleJob(reminder._id, reminderAt);
    reminder.jobId = String(job.id);
    await reminder.save();
    return "";
  } catch (error) {
    await Reminder.findByIdAndDelete(reminder._id);
    console.error("Could not schedule booking reminder:", error.message);
    return `Booking confirmed, but its reminder could not be scheduled: ${error.message}`;
  }
}

async function cancelBookingReminder(booking) {
  const reminders = await Reminder.find({ bookingId: booking._id, status: "pending" });
  for (const reminder of reminders) {
    await cancelJob(reminder.jobId);
    reminder.status = "cancelled";
    await reminder.save();
  }
}

async function loyaltyForBooking(booking) {
  const category = menuCategoryForPackage(booking.package);
  const [setting, menu, visits] = await Promise.all([
    Setting.findOne({ restaurantId: booking.restaurantId }).lean(),
    category ? Menu.findOne({ restaurantId: booking.restaurantId, category }).lean() : null,
    Booking.find({ restaurantId: booking.restaurantId, status: { $in: ["checked_in", "completed"] } }).select("customerPhone package").lean(),
  ]);
  const config = menu?.loyalty || setting?.loyalty || { enabled: true, visitsForReward: 5, rewardText: "Chef Special Dessert" };
  const phone = String(booking.customerPhone || "").replace(/\D/g, "");
  const visitCount = visits.filter((visit) =>
    String(visit.customerPhone || "").replace(/\D/g, "") === phone &&
    (!category || menuCategoryForPackage(visit.package) === category)
  ).length;
  const required = config.visitsForReward || 5;
  const cycle = visitCount % required;
  const rewardEarned = Boolean(config.enabled && visitCount && cycle === 0);
  const remaining = cycle === 0 ? required : required - cycle;
  const lastTwo = visitCount % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[visitCount % 10] || "th";
  const message = !config.enabled ? "" : rewardEarned
    ? `Congratulations! You have earned a FREE ${config.rewardText}. Your next reward cycle starts now.`
    : `Thank you for your ${visitCount}${suffix} visit to Hotel d'GATES. You are ${remaining} more ${remaining === 1 ? "visit" : "visits"} away to enjoy '${config.rewardText}' for FREE.`;
  return { visitCount, visitsForReward: required, visitsRemaining: remaining, rewardText: config.rewardText, rewardEarned, enabled: config.enabled, message };
}

// ======================
// Get all bookings
// ======================
exports.getAllBookings = async (req, res) => {
  try {
    const restaurantId = req.admin.restaurantId;

    console.log(`\n📅 getAllBookings:`);
    console.log(`   Restaurant: ${restaurantId}`);

    const bookings = await Booking.find({
      restaurantId: restaurantId
    }).sort({ createdAt: -1 });

    console.log(`✅ Found ${bookings.length} bookings`);

    res.json({
      success: true,
      data: bookings
    });
  } catch (error) {
    console.error("❌ Get All Bookings Error:", error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ======================
// Create booking (Admin)
// ======================
exports.createBooking = async (req, res) => {
  try {
    const restaurantId = req.admin.restaurantId;

    console.log(`\n📝 createBooking:`);
    console.log(`   Restaurant: ${restaurantId}`);

    const availability = await checkBookingCapacity(req.body, restaurantId);
    if (availability && !availability.available) {
      return res.status(409).json({ success: false, message: availability.reason || `No ${availabilityCategoryForPackage(req.body.package, req.body.bookingCategory)} availability for this time.`, availability });
    }
    const bookingData = { ...req.body };
    const policy = await getBookingPaymentPolicyForCategory(restaurantId, paymentPolicyCategoryFor(bookingData));
    bookingData.paymentDeadlineAt = null;
    bookingData.paymentDeadlineAction = "no_action";
    bookingData.paymentDeadlineHandledAt = null;
    if (isRoomBooking(bookingData) && availability) {
      const checkIn = roomDateObject(String(bookingData.bookingDate).slice(0, 10));
      const checkOut = roomDateObject(String(bookingData.checkOutDate).slice(0, 10));
      bookingData.roomType = availability.roomType.name;
      bookingData.totalAmount = Math.round(availability.roomType.baseRate * Number(bookingData.numberOfRooms || 1) * ((checkOut - checkIn) / 86400000) * 100) / 100;
      bookingData.bookingTime = bookingData.bookingTime || "15:00";
    }
    bookingData.advancePercent = policy.advancePercent;
    bookingData.advanceAmount = calculateAdvanceAmount(bookingData.totalAmount, policy.advancePercent);
    if (policy.advancePercent === 0) bookingData.paymentStatus = "not_required";
    if (bookingData.status !== "confirmed" && bookingData.advancePercent > 0) setPaymentDeadline(bookingData, policy);
    const booking = await Booking.create({
      ...bookingData,
      restaurantId,
      handledBy: "cs_manual",
      bookingSource: bookingData.bookingSource || "in-person",
    });

    emitBooking(req, "new_booking", booking);
    const reminderWarning = booking.status === "confirmed" ? await scheduleBookingReminder(booking) : "";

    console.log(`✅ Booking created: ${booking._id}`);

    res.status(201).json({
      success: true,
      data: booking,
      ...(reminderWarning ? { warning: reminderWarning } : {}),
    });
  } catch (error) {
    console.error("❌ Create Booking Error:", error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message
    });
  }
};

// ======================
// Get booking by ID
// ======================
exports.getBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid booking id" });

    console.log(`\n📅 getBookingById: ${id}`);

    const booking = await Booking.findOne({ _id: id, restaurantId: req.admin.restaurantId });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found"
      });
    }

    console.log(`✅ Booking found: ${booking._id}`);

    res.json({
      success: true,
      data: booking
    });
  } catch (error) {
    console.error("❌ Get Booking Error:", error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ======================
// Create booking from WhatsApp (n8n)
// ======================
exports.createBookingFromWhatsApp = async (req, res) => {
  try {
    if (process.env.N8N_API_KEY && req.get("x-api-key") !== process.env.N8N_API_KEY) {
      return res.status(401).json({ success: false, message: "Invalid API key" });
    }
    const { bookingData, fromNumber, restaurantId = "restaurant-1" } = req.body;

    if (!bookingData || !fromNumber) {
      return res.status(400).json({
        success: false,
        message: "bookingData and fromNumber are required"
      });
    }

    let parsed = bookingData;
    if (typeof bookingData === "string") {
      try {
        parsed = JSON.parse(bookingData);
      } catch (e) {
        return res.status(400).json({ success: false, message: "bookingData must be valid JSON" });
      }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return res.status(400).json({ success: false, message: "bookingData must be an object" });
    }
    const assignedRestaurantId = parsed.restaurantId || restaurantId;
    const roomBooking = isRoomBooking(parsed);
    const totalAmount = Number(parsed.totalAmount);
    if (!roomBooking && (!Number.isFinite(totalAmount) || totalAmount <= 0)) {
      return res.status(400).json({ success: false, message: "A valid menu-based totalAmount is required before creating a WhatsApp booking." });
    }
    const selectedItems = Array.isArray(parsed.selectedItems)
      ? parsed.selectedItems.map((item) => ({
          name: String(item?.name || "").trim(),
          quantity: Number.isInteger(Number(item?.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : 1,
          unitPrice: item?.unitPrice != null && Number.isFinite(Number(item.unitPrice)) && Number(item.unitPrice) >= 0 ? Number(item.unitPrice) : null,
          notes: String(item?.notes || "").trim(),
        })).filter((item) => item.name)
      : [];
    if (!selectedItems.length && String(parsed.package || "").trim()) {
      selectedItems.push({ name: String(parsed.package).trim(), quantity: 1, unitPrice: null, notes: "" });
    }
    const bookingDetails = Array.isArray(parsed.bookingDetails)
      ? parsed.bookingDetails.map((detail) => ({
          label: String(detail?.label || "").trim(),
          value: String(detail?.value || "").trim(),
        })).filter((detail) => detail.label && detail.value)
      : [];
    const bookingCategory = String(
      parsed.bookingCategory === "Wedding" ? "Wedding Package"
        : /d['’]fusion|fusion.*restaurant|revolving.*restaurant.*a\s*la\s*carte|revolving.*a\s*la\s*carte/i.test(String(parsed.bookingCategory || "")) ? "D'Fusion Revolving Restaurant: A La Carte Menu"
          : /^a\s*la\s*carte/i.test(String(parsed.bookingCategory || "")) ? "À la carte / Restaurant Reservation"
            : parsed.bookingCategory || menuCategoryForPackage(parsed.package) || ""
    ).trim();
    const policyCategory = roomBooking ? "Rooms" : (bookingCategory === "Wedding" ? "Wedding Package" : bookingCategory);
    const policy = await getBookingPaymentPolicyForCategory(assignedRestaurantId, policyCategory);
    const payload = {
      customerId: fromNumber,
      customerName: parsed.customerName || "WhatsApp Customer",
      customerPhone: fromNumber,
      customerEmail: parsed.customerEmail || "",
      handledBy: "whatsapp-bot",
      customerLanguage: parsed.customerLanguage || detectLanguage(parsed.notes || parsed.specialRequests || ""),
      package: parsed.package || "",
      bookingCategory,
      selectedItems,
      bookingDetails,
      numberOfPersons: parsed.numberOfPersons || 1,
      bookingDate: parsed.bookingDate,
      bookingTime: parsed.bookingTime || (roomBooking ? "15:00" : ""),
      roomTypeId: parsed.roomTypeId || undefined,
      roomType: parsed.roomType || "",
      checkOutDate: parsed.checkOutDate || undefined,
      numberOfRooms: roomBooking ? Number(parsed.numberOfRooms || 1) : undefined,
      specialRequests: parsed.specialRequests || "",
      restaurantId: assignedRestaurantId,
      status: "pending",
      bookingSource: "whatsapp-bot",
      totalAmount,
      advanceAmount: calculateAdvanceAmount(totalAmount, policy.advancePercent),
      advancePercent: policy.advancePercent,
      paymentMethod: parsed.paymentMethod || "",
      paymentScreenshotUrl: "",
      paymentStatus: policy.advancePercent === 0 ? "not_required" : "unpaid",
      offerApplied: parsed.offerApplied || "",
    };
    const requestedDate = typeof payload.bookingDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(payload.bookingDate)
      ? payload.bookingDate.slice(0, 10)
      : payload.bookingDate && !Number.isNaN(new Date(payload.bookingDate).getTime())
        ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Karachi",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(payload.bookingDate))
        : "";
    if (!requestedDate) return res.status(400).json({ success: false, message: "A valid booking date is required." });
    const serviceSetting = await Setting.findOne({ restaurantId: assignedRestaurantId }).select("serviceClosures").lean();
    let requestDates = [requestedDate];
    if (roomBooking) {
      const checkIn = roomDateObject(requestedDate);
      const checkOut = roomDateObject(String(payload.checkOutDate || "").slice(0, 10));
      if (!checkIn || !checkOut || checkOut <= checkIn) {
        return res.status(400).json({ success: false, message: "Room bookings require a valid check-out date after check-in." });
      }
      requestDates = [];
      for (const date = new Date(checkIn); date < checkOut; date.setUTCDate(date.getUTCDate() + 1)) {
        requestDates.push(date.toISOString().slice(0, 10));
      }
    }
    const closure = serviceSetting?.serviceClosures?.find((item) => requestDates.includes(item.date));
    if (closure) {
      return res.status(409).json({
        success: false,
        message: `Hotel service is closed on ${requestedDate}: ${closure.reason}`,
        closure: { date: closure.date, reason: closure.reason },
      });
    }
    const availability = await checkBookingCapacity(payload, assignedRestaurantId);
    if (availability && !availability.available) {
      return res.status(409).json({
        success: false,
        message: availability.reason || `The requested ${availabilityCategoryForPackage(payload.package, payload.bookingCategory)} time is not available.`,
        availability,
      });
    }
    if (roomBooking && availability?.roomType) {
      const checkIn = roomDateObject(String(payload.bookingDate).slice(0, 10));
      const checkOut = roomDateObject(String(payload.checkOutDate).slice(0, 10));
      const nights = (checkOut - checkIn) / 86400000;
      payload.roomType = availability.roomType.name;
      payload.totalAmount = Math.round(availability.roomType.baseRate * payload.numberOfRooms * nights * 100) / 100;
      if (payload.totalAmount <= 0) return res.status(400).json({ success: false, message: "Configure a positive room rate before taking a room booking." });
      payload.advanceAmount = calculateAdvanceAmount(payload.totalAmount, policy.advancePercent);
    }
    if (payload.advancePercent > 0) setPaymentDeadline(payload, policy);
    const booking = await Booking.create({
      ...payload,
      notes: parsed.notes || "",
    });

    console.log("✅ Booking created:", booking._id);

    emitBooking(req, "new_booking", booking);

    let payment = paymentInstructions(booking);
    if (!payment || typeof payment !== "object") {
      console.error("paymentInstructions() returned empty after booking save; sending unconfigured payload");
      payment = unconfiguredPayment(booking);
    }

    res.status(201).json({
      success: true,
      message: "Booking created from WhatsApp AI",
      data: booking,
      paymentInstructions: payment,
      payment,
    });

  } catch (error) {
    console.error("❌ Create Booking from WhatsApp Error:", error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message
    });
  }
};

// ======================
// Update booking status only (quick confirm/cancel)
// ======================
exports.updateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid booking id" });
    const { status, remarks = "" } = req.body;
    const statuses = ["pending", "pending_payment_verification", "confirmed", "checked_in", "completed", "cancelled", "no_show"];
    if (!statuses.includes(status)) return res.status(400).json({ success: false, message: `status must be one of: ${statuses.join(", ")}` });

    console.log(`\n📅 updateBookingStatus:`);
    console.log(`   ID: ${id}`);
    console.log(`   Status: ${status}`);

    const booking = await Booking.findOne({ _id: id, restaurantId: req.admin.restaurantId });
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    const cancellationReason = String(remarks || "").trim();
    if (status === "cancelled" && !cancellationReason) {
      return res.status(400).json({ success: false, message: "Enter a cancellation reason to send to the customer." });
    }
    if (status === "cancelled" && cancellationReason.length > 500) {
      return res.status(400).json({ success: false, message: "Cancellation reason must be 500 characters or fewer." });
    }
    if (status === "confirmed") {
      const result = await confirmAndNotify(req, booking);
      if (result.error) return res.status(409).json({ success: false, message: result.error, data: booking });
      return res.json({ success: true, data: result.booking, ...(result.warning ? { warning: result.warning } : {}) });
    }
    const previousStatus = booking.status;
    booking.status = status;
    if (String(remarks || "").trim()) booking.csRemarks = String(remarks).trim().slice(0, 1000);
    if (status === "cancelled" && ["verifying", "proof_received", "unpaid", "payment_declined"].includes(booking.paymentStatus)) {
      booking.paymentStatus = "rejected";
      booking.paymentDeclineReason = cancellationReason.slice(0, 500);
    }
    let cancellationWarning = "";
    let cancellationMessage = "";
    const shouldNotifyCancellation = status === "cancelled" &&
      (previousStatus !== "cancelled" || booking.cancellationMessageStatus === "failed");
    if (status === "cancelled" && previousStatus !== "cancelled") {
      booking.cancellationMessageStatus = "not_sent";
      booking.cancellationMessageError = "";
    }
    await booking.save();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found"
      });
    }

    if (status === "cancelled") {
      await cancelBookingReminder(booking);
      if (previousStatus !== "cancelled") {
        void notifyDashboard(req, booking, "booking_cancelled", "Booking cancelled", `${booking.customerName || "Customer"} · ${booking.package || "Booking"}`);
      }
      if (shouldNotifyCancellation) {
        cancellationMessage = buildCustomerCancellationMessage(booking.customerLanguage, cancellationReason);
        try {
          await sendWhatsAppText(booking.customerPhone, cancellationMessage);
          booking.cancellationMessageStatus = "sent";
          booking.cancellationMessageError = "";
        } catch (error) {
          cancellationWarning = error.response?.data?.error?.message || error.message || "WhatsApp cancellation message could not be sent.";
          booking.cancellationMessageStatus = "failed";
          booking.cancellationMessageError = cancellationWarning.slice(0, 500);
          console.error(`Booking ${booking._id} was cancelled, but the customer WhatsApp message failed:`, cancellationWarning);
        }
        await booking.save();
        try {
          const cancellationChat = await Chat.create({
            restaurantId: booking.restaurantId,
            customerPhone: booking.customerPhone,
            customerName: booking.customerName,
            botReply: cancellationMessage,
            sender: "admin",
            direction: "admin_to_customer",
            source: "booking_cancellation",
            status: cancellationWarning ? "failed" : "sent",
            isBookingRelated: true,
            bookingId: booking._id,
            metadata: cancellationWarning ? { error: cancellationWarning } : {},
          });
          req.app.get("io")?.to("chat-admins").emit("whatsapp-new-message", {
            phone: booking.customerPhone.replace(/\D/g, ""),
            customerName: booking.customerName,
            botReply: cancellationMessage,
            sender: "admin",
            isBot: false,
            timestamp: cancellationChat.createdAt,
            chatId: cancellationChat._id,
          });
        } catch (error) {
          const historyError = `Cancellation message history could not be saved: ${error.message}`;
          cancellationWarning = [cancellationWarning, historyError].filter(Boolean).join(" ");
          console.error(`Booking ${booking._id} cancellation message history save failed:`, error.message);
        }
      }
    }
    if (booking) emitBooking(req, "booking_updated", booking);

    console.log(`✅ Booking status updated: ${booking._id}`);

    res.json({
      success: true,
      data: booking,
      ...(cancellationWarning ? {
        warning: `Booking was cancelled, but the customer WhatsApp message could not be sent: ${cancellationWarning}. Open Chat History to send it manually.`,
      } : {}),
    });
  } catch (error) {
    console.error("❌ Update Booking Status Error:", error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.confirmBooking = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid booking id" });
    const booking = await Booking.findOne({ _id: req.params.id, restaurantId: req.admin.restaurantId });
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    if (booking.status === "confirmed" && booking.confirmationMessageStatus !== "failed") {
      return res.status(409).json({ success: false, message: "This booking is already confirmed and its WhatsApp message was sent." });
    }
    const result = await confirmAndNotify(req, booking);
    if (result.error) return res.status(409).json({ success: false, message: result.error });
    res.json({ success: true, data: result.booking, ...(result.warning ? { warning: result.warning } : {}) });
  } catch (error) {
    console.error("confirmBooking error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ======================
// Update full booking details (CRM edit)
// ======================
exports.updateBooking = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid booking id" });

    const allowedFields = [
      "customerName",
      "customerEmail",
      "customerPhone",
      "package",
      "numberOfPersons",
      "bookingDate",
      "bookingTime",
      "roomTypeId",
      "roomType",
      "checkOutDate",
      "numberOfRooms",
      "specialRequests",
      "notes", "csRemarks", "totalAmount", "advanceAmount", "paymentMethod", "offerApplied",
      "bookingCategory", "selectedItems", "bookingDetails", "handledBy", "paymentStatus",
    ];

    const updateData = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });
    console.log(`\n✏️ updateBooking:`);
    console.log(`   ID: ${id}`);
    console.log(`   Fields:`, updateData);

    const existingBooking = await Booking.findOne({ _id: id, restaurantId: req.admin.restaurantId });
    if (!existingBooking) return res.status(404).json({ success: false, message: "Booking not found" });
    const availabilityData = { ...existingBooking.toObject(), ...updateData };
    const availability = await checkBookingCapacity(availabilityData, req.admin.restaurantId, id);
    if (availability && !availability.available) {
      return res.status(409).json({ success: false, message: availability.reason || "The selected availability is no longer open.", availability });
    }
    if (isRoomBooking(availabilityData) && availability) {
      const checkIn = roomDateObject(availabilityData.bookingDate instanceof Date ? availabilityData.bookingDate.toISOString().slice(0, 10) : String(availabilityData.bookingDate).slice(0, 10));
      const checkOut = roomDateObject(availabilityData.checkOutDate instanceof Date ? availabilityData.checkOutDate.toISOString().slice(0, 10) : String(availabilityData.checkOutDate).slice(0, 10));
      const totalAmount = Math.round(availability.roomType.baseRate * Number(availabilityData.numberOfRooms || 1) * ((checkOut - checkIn) / 86400000) * 100) / 100;
      updateData.roomType = availability.roomType.name;
      updateData.totalAmount = totalAmount;
    }
    if (updateData.totalAmount !== undefined) {
      const advancePercent = Number(existingBooking.advancePercent ?? 20);
      updateData.advancePercent = advancePercent;
      updateData.advanceAmount = calculateAdvanceAmount(updateData.totalAmount, advancePercent);
      if (advancePercent === 0 && ["unpaid", "payment_declined"].includes(existingBooking.paymentStatus)) {
        updateData.paymentStatus = "not_required";
      }
    }
    const booking = await Booking.findOneAndUpdate(
      { _id: id, restaurantId: req.admin.restaurantId },
      updateData,
      { new: true, runValidators: true }
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found"
      });
    }

    if (booking.status === "confirmed") await scheduleBookingReminder(booking);
    if (booking.status === "cancelled") await cancelBookingReminder(booking);
    emitBooking(req, "booking_updated", booking);

    console.log(`✅ Booking fully updated: ${booking._id}`);

    res.json({ success: true, data: booking });
  } catch (error) {
    console.error("❌ Update Booking Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.capturePaymentScreenshot = async (req, res) => {
  try {
    if (process.env.N8N_API_KEY && req.get("x-api-key") !== process.env.N8N_API_KEY) {
      return res.status(401).json({ success: false, message: "Invalid API key" });
    }
    const { url, mediaId, customerPhone, caption = "", restaurantId = "restaurant-1" } = req.body;
    const mediaType = String(req.body.mediaType || "image").toLowerCase();
    const saveOnly = req.body.saveOnly === true;
    if (!["image", "video", "audio", "document"].includes(mediaType)) {
      return res.status(400).json({ success: false, message: "Unsupported WhatsApp media type" });
    }
    if (!mediaId && (typeof url !== "string" || !/^https?:\/\/\S+$/i.test(url))) {
      return res.status(400).json({ success: false, message: "A valid media URL or WhatsApp mediaId is required" });
    }
    const phone = String(customerPhone || "").replace(/\D/g, "");
    if (phone.length < 7) return res.status(400).json({ success: false, message: "A valid customerPhone is required" });
    const paymentProofType = ["image", "document"].includes(mediaType);
    let booking;
    let weddingBooking;
    let corporateBooking;
    if (paymentProofType && !saveOnly && req.params.id) {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid booking id" });
      booking = await Booking.findOne({ _id: req.params.id, restaurantId });
    } else if (paymentProofType && !saveOnly) {
      const [candidates, weddingCandidates, corporateCandidates] = await Promise.all([
        Booking.find({ restaurantId, status: { $in: ["pending", "pending_payment_verification"] } }).sort({ createdAt: -1 }).limit(100),
        WeddingBooking.find({ restaurantId, bookingType: "wedding", paymentVerified: false, stage: { $in: ["proposal", "advance_payment", "agreement", "cs_verification"] } }).sort({ createdAt: -1 }).limit(100),
        WeddingBooking.find({ restaurantId, bookingType: "corporate", paymentVerified: false, stage: { $in: ["proposal", "advance_payment", "agreement", "cs_verification"] } }).sort({ createdAt: -1 }).limit(100),
      ]);
      booking = candidates.find((candidate) => matchPhone(candidate.customerPhone, phone));
      weddingBooking = weddingCandidates.find((candidate) => matchPhone(candidate.customerPhone, phone));
      corporateBooking = corporateCandidates.find((candidate) => matchPhone(candidate.customerPhone, phone));
      const matches = [booking, weddingBooking, corporateBooking].filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
      booking = matches[0] instanceof Booking ? matches[0] : null;
      weddingBooking = matches[0] instanceof WeddingBooking && matches[0].bookingType === "wedding" ? matches[0] : null;
      corporateBooking = matches[0] instanceof WeddingBooking && matches[0].bookingType === "corporate" ? matches[0] : null;
    }
    if (paymentProofType && req.params.id && !booking) return res.status(404).json({ success: false, message: "Booking not found" });
    if (booking && !["pending", "pending_payment_verification"].includes(booking.status)) return res.status(409).json({ success: false, message: "Payment screenshot can only be attached to a pending booking" });
    if (weddingBooking?.paymentVerified) return res.status(409).json({ success: false, message: "This wedding advance has already been verified." });
    if (corporateBooking?.paymentVerified) return res.status(409).json({ success: false, message: "This corporate advance has already been verified." });
    const attachedBooking = booking || weddingBooking || corporateBooking;

    let screenshotUrl = url;
    let mediaFilename = "";
    if (mediaId) {
      const whatsAppAccessToken = readEnv("WHATSAPP_ACCESS_TOKEN") || readEnv("WHATSAPP_TOKEN");
      const requiredConfig = [
        whatsAppAccessToken,
        process.env.CLOUDINARY_CLOUD_NAME,
        process.env.CLOUDINARY_API_KEY,
        process.env.CLOUDINARY_API_SECRET,
      ];
      if (requiredConfig.some((value) => !value)) {
        return res.status(503).json({ success: false, message: "WhatsApp media and Cloudinary upload credentials must be configured to save incoming media." });
      }
      const media = await axios.get(`https://graph.facebook.com/v18.0/${encodeURIComponent(mediaId)}`, {
        headers: { Authorization: `Bearer ${whatsAppAccessToken}` },
      });
      if (typeof media.data?.url !== "string" || !media.data.url.startsWith("https://")) {
        return res.status(502).json({ success: false, message: "WhatsApp did not provide a valid media URL." });
      }
      mediaFilename = String(media.data.filename || "");
      const image = await axios.get(media.data.url, {
        headers: { Authorization: `Bearer ${whatsAppAccessToken}` },
        responseType: "arraybuffer",
        maxContentLength: 10 * 1024 * 1024,
        maxBodyLength: 10 * 1024 * 1024,
      });
      const contentType = String(image.headers["content-type"] || "").split(";")[0].toLowerCase();
      const expectedType = mediaType === "document"
        ? contentType === "application/pdf"
        : contentType.startsWith(`${mediaType}/`);
      if (!expectedType) {
        return res.status(415).json({ success: false, message: `WhatsApp media content does not match the declared ${mediaType} type.` });
      }
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
      const resourceType = mediaType === "image" ? "image" : mediaType === "video" ? "video" : "raw";
      const uploaded = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({
          resource_type: resourceType,
          folder: attachedBooking ? "hotel-crm/payments" : "hotel-crm/customer-media",
          ...(mediaType === "document" && mediaFilename ? { use_filename: true, unique_filename: true, filename_override: mediaFilename } : {}),
        }, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
        stream.end(Buffer.from(image.data));
      });
      screenshotUrl = uploaded.secure_url;
    }

    if (booking) {
      booking.paymentScreenshotUrl = screenshotUrl;
      booking.paymentStatus = "proof_received";
      booking.status = "pending_payment_verification";
      // The proof is forwarded to CS immediately, so no extra customer confirmation is needed.
      booking.paymentProofConfirmedByCustomer = true;
      if (caption) booking.customerLanguage = detectLanguage(caption, booking.customerLanguage);
      await booking.save();
    } else if (weddingBooking) {
      weddingBooking.paymentProofUrl = screenshotUrl;
      weddingBooking.paymentProofConfirmedByCustomer = true;
      weddingBooking.paymentStatus = "proof_received";
      weddingBooking.paymentVerified = false;
      weddingBooking.awaitingAdvancePayment = false;
      if (weddingBooking.stage !== "cs_verification") {
        weddingBooking.stage = "cs_verification";
        weddingBooking.stageHistory.push({
          stage: "cs_verification",
          actorName: "WhatsApp AI",
          note: "Customer payment proof received; awaiting customer confirmation and CS verification.",
        });
      }
      await weddingBooking.save();
    } else if (corporateBooking) {
      corporateBooking.paymentProofUrl = screenshotUrl;
      corporateBooking.paymentProofConfirmedByCustomer = true;
      corporateBooking.paymentStatus = "proof_received";
      corporateBooking.paymentVerified = false;
      if (corporateBooking.stage !== "cs_verification") {
        corporateBooking.stage = "cs_verification";
        corporateBooking.stageHistory.push({
          stage: "cs_verification",
          actorName: "WhatsApp AI",
          note: "Customer payment proof received; awaiting customer confirmation and CS verification.",
        });
      }
      await corporateBooking.save();
    }
    if (attachedBooking) {
      const bookingName = attachedBooking.package || attachedBooking.selectedMenuName || attachedBooking.packageName ||
        (attachedBooking.bookingType === "wedding" ? "Wedding booking" :
          attachedBooking.bookingType === "corporate" ? "Corporate booking" : "Booking");
      const amount = Number(attachedBooking.advanceAmount || attachedBooking.quotation?.advanceRequired || 0);
      void publishDashboardNotification(req, {
        restaurantId: attachedBooking.restaurantId,
        sourceKey: `payment_proof_received:${attachedBooking._id}:${Date.now()}`,
        type: "payment_proof_received",
        title: "Customer sent payment proof",
        message: `${attachedBooking.customerName || "Customer"} · ${bookingName}${amount ? ` · Rs ${amount.toLocaleString("en-PK")}` : ""}`,
        entityType: "booking",
        entityId: String(attachedBooking._id),
      }).catch((error) => console.error("Dashboard payment proof notification failed:", error));
    }
    await Chat.create({
      restaurantId,
      customerPhone: attachedBooking?.customerPhone || phone,
      customerName: attachedBooking?.customerName || "WhatsApp Customer",
      customerMessage: String(caption).slice(0, 1000),
      messageType: mediaType,
      mediaUrl: screenshotUrl,
      sender: "customer",
      direction: "customer_to_bot",
      source: attachedBooking ? "whatsapp_payment_proof" : "whatsapp_customer_media",
      status: "received",
      isBookingRelated: Boolean(attachedBooking),
      bookingId: booking?._id || null,
      metadata: weddingBooking ? { weddingBookingId: String(weddingBooking._id), paymentProofUrl: screenshotUrl }
        : corporateBooking ? { corporateBookingId: String(corporateBooking._id), bookingType: "corporate", paymentProofUrl: screenshotUrl } : {},
    });

    const io = req.app.get("io");
    let sendPaymentAlert = false;
    if (attachedBooking) {
      try {
        const settings = await getSupportSettings(restaurantId);
        sendPaymentAlert = isSupportTypeAvailable(settings, "payment_alert");
      } catch (error) {
        console.error("Could not check payment-alert schedule:", error.message);
      }
    }
    if (io) {
      if (attachedBooking && sendPaymentAlert) io.to("chat-admins").emit("payment_screenshot_received", { restaurantId, booking: attachedBooking, bookingType: corporateBooking ? "corporate" : weddingBooking ? "wedding" : "standard" });
      io.to("chat-admins").emit("whatsapp-new-message", {
        phone: attachedBooking?.customerPhone || phone,
        customerName: attachedBooking?.customerName || "WhatsApp Customer",
        customerMessage: String(caption).slice(0, 1000),
        mediaUrl: screenshotUrl,
        mediaType,
        sender: "customer",
        timestamp: new Date(),
      });
    }
    if (booking) emitBooking(req, "booking_updated", booking);
    if (weddingBooking) {
      const io = req.app.get("io");
      if (io) io.to("chat-admins").emit("wedding_booking_updated", { bookingId: weddingBooking._id, restaurantId, booking: weddingBooking });
    }
    if (corporateBooking) {
      const io = req.app.get("io");
      if (io) io.to("chat-admins").emit("corporate_booking_updated", { bookingId: corporateBooking._id, restaurantId, booking: corporateBooking });
    }
    const language = detectLanguage(caption, attachedBooking?.customerLanguage || "en");
    let csWarning = "";
    let csNotificationSkipped = false;
    if (attachedBooking) {
      try {
        const notifyResult = await notifyCsTeam({
          caption: booking ? csPaymentCaption(booking) : eventPaymentCaption(attachedBooking, corporateBooking ? "corporate" : "wedding"),
          mediaUrl: screenshotUrl,
          mediaType: mediaType === "document" ? "document" : "image",
          mediaFilename,
          restaurantId,
          scheduleType: "payment_alert",
        });
        csNotificationSkipped = notifyResult === null;
        csWarning = notifyResult || "";
      } catch (error) {
        csWarning = `Proof was saved, but the CS WhatsApp notification failed: ${error.response?.data?.error?.message || error.message}`;
        console.error(csWarning);
      }
    }
    const customerReply = attachedBooking
      ? (csWarning
        ? customerCsNotifyFailureText(language)
        : csNotificationSkipped ? proofSavedForSupportHoursText(language) : proofReceivedText(language))
      : language === "ur"
        ? "آپ کی فائل موصول ہو گئی ہے اور ٹیم کے لیے محفوظ کر لی گئی ہے۔"
        : language === "roman"
          ? "Aapki file mil gayi hai aur team ke liye save kar di gayi hai."
          : "We received your file and saved it for our team to review.";
    if (attachedBooking) {
      // Keep the bot's answer visible in Chat History next to the customer's screenshot.
      await Chat.create({
        restaurantId,
        customerPhone: attachedBooking.customerPhone || phone,
        customerName: attachedBooking.customerName || "WhatsApp Customer",
        botReply: customerReply,
        sender: "bot",
        direction: "bot_to_customer",
        source: "payment_proof_received",
        status: "sent",
        isBookingRelated: true,
        bookingId: booking?._id || null,
      }).catch((error) => console.error("Payment proof reply log failed:", error.message));
    }
    res.json({
      success: true,
      attachedToBooking: Boolean(attachedBooking),
      needsCustomerConfirmation: false,
      ...(csWarning ? { warning: csWarning } : {}),
      customerReply,
      bookingType: corporateBooking ? "corporate" : weddingBooking ? "wedding" : booking ? "standard" : null,
      data: attachedBooking || null,
      screenshotUrl,
    });
  } catch (error) {
    console.error("capturePaymentScreenshot error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const { advanceAmount, paymentMethod } = req.body;
    if (advanceAmount !== undefined && (!Number.isFinite(Number(advanceAmount)) || Number(advanceAmount) < 0)) {
      return res.status(400).json({ success: false, message: "advanceAmount must be a non-negative number" });
    }
    if (paymentMethod !== undefined && typeof paymentMethod !== "string") return res.status(400).json({ success: false, message: "paymentMethod must be a string" });
    const booking = await Booking.findOne({ _id: req.params.id, restaurantId: req.admin.restaurantId });
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    if (booking.handledBy === "whatsapp-bot" && !booking.paymentProofConfirmedByCustomer) {
      return res.status(409).json({ success: false, message: "Wait for the customer to confirm the submitted payment proof before verification." });
    }
    if (!["pending", "pending_payment_verification"].includes(booking.status) || !["verifying", "proof_received"].includes(booking.paymentStatus) || !booking.paymentScreenshotUrl) {
      return res.status(409).json({ success: false, message: "A pending booking with a submitted payment proof is required before payment can be verified." });
    }
    booking.paymentStatus = "advance_received";
    if (advanceAmount !== undefined) booking.advanceAmount = Number(advanceAmount);
    if (paymentMethod !== undefined) booking.paymentMethod = paymentMethod.trim();
    booking.paymentVerifiedBy = req.admin._id;
    booking.paymentVerifiedAt = new Date();
    await booking.save();
    const result = await confirmAndNotify(req, booking);
    if (result.error) {
      emitBooking(req, "booking_updated", booking);
      return res.json({ success: true, data: booking, warning: `Payment verified, but confirmation could not be sent: ${result.error}` });
    }
    res.json({
      success: true,
      data: result.booking,
      message: "Payment verified. Booking confirmed and WhatsApp confirmation sent to the customer.",
      ...(result.warning ? { warning: result.warning } : {}),
    });
  } catch (error) {
    console.error("verifyPayment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.checkInBooking = async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, restaurantId: req.admin.restaurantId });
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    if (!["confirmed", "checked_in"].includes(booking.status)) return res.status(409).json({ success: false, message: "Only confirmed bookings can be checked in" });
    booking.status = "checked_in";
    booking.checkedInAt = booking.checkedInAt || new Date();
    await booking.save();
    const loyalty = await loyaltyForBooking(booking);
    emitBooking(req, "booking_updated", booking);
    res.json({ success: true, data: booking, loyalty });
  } catch (error) {
    console.error("checkInBooking error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.sendTodayBookingFollowUp = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid booking id." });
    }
    const { message, sourceType = "booking" } = req.body;
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) return res.status(400).json({ success: false, message: "Write a message before sending." });
    if (cleanMessage.length > 4096) return res.status(400).json({ success: false, message: "Message must be 4096 characters or fewer." });
    if (!["booking", "wedding", "corporate"].includes(sourceType)) {
      return res.status(400).json({ success: false, message: "Invalid booking type." });
    }

    const timezone = process.env.SLOT_TIMEZONE || "Asia/Karachi";
    const dateKey = (value) => {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(date);
      return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
    };
    const todayParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const today = `${todayParts.find((part) => part.type === "year")?.value}-${todayParts.find((part) => part.type === "month")?.value}-${todayParts.find((part) => part.type === "day")?.value}`;

    let booking;
    let eventDate;
    if (sourceType === "booking") {
      booking = await Booking.findOne({
        _id: req.params.id, restaurantId: req.admin.restaurantId, status: "confirmed",
      });
      eventDate = booking?.bookingDate;
    } else {
      booking = await WeddingBooking.findOne({
        _id: req.params.id,
        restaurantId: req.admin.restaurantId,
        bookingType: sourceType,
        stage: "confirmed",
      });
      eventDate = sourceType === "wedding"
        ? booking?.acceptedAlternateDate || booking?.answers?.weddingDate
        : booking?.acceptedAlternateDate || booking?.answers?.eventDate;
    }

    if (!booking) return res.status(404).json({ success: false, message: "Confirmed booking not found." });
    if (dateKey(eventDate) !== today) {
      return res.status(409).json({ success: false, message: "Messages can only be sent from this page for confirmed bookings scheduled today." });
    }

    try {
      await sendWhatsAppTextService(booking.customerPhone, cleanMessage);
    } catch (error) {
      const sendError = error.response?.data?.error?.message || error.message;
      console.error(`Today booking follow-up WhatsApp send failed for ${booking._id}:`, sendError);
      return res.status(502).json({ success: false, message: `WhatsApp message could not be sent: ${sendError}` });
    }

    let warning = "";
    try {
      const chat = await Chat.create({
        restaurantId: booking.restaurantId,
        customerPhone: booking.customerPhone,
        customerName: booking.customerName || "WhatsApp Customer",
        botReply: cleanMessage,
        sender: "admin",
        direction: "admin_to_customer",
        source: "today_booking_follow_up",
        status: "sent",
        isBookingRelated: true,
        ...(sourceType === "booking" ? { bookingId: booking._id } : {}),
        metadata: sourceType === "booking"
          ? { bookingId: String(booking._id), bookingType: sourceType }
          : { [`${sourceType}BookingId`]: String(booking._id), bookingType: sourceType },
      });
      req.app.get("io")?.to("chat-admins").emit("whatsapp-new-message", {
        phone: booking.customerPhone.replace(/\D/g, ""),
        customerName: booking.customerName,
        botReply: cleanMessage,
        sender: "admin",
        isBot: false,
        timestamp: chat.createdAt,
        chatId: chat._id,
      });
    } catch (error) {
      warning = `Message was sent, but it could not be saved to Chat History: ${error.message}`;
      console.error(`Today booking follow-up history save failed for ${booking._id}:`, error.message);
    }

    return res.json({ success: true, message: "WhatsApp message sent.", ...(warning ? { warning } : {}) });
  } catch (error) {
    console.error("sendTodayBookingFollowUp error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const findLatestForPhone = async (restaurantId, phone, extra = {}) => {
  const candidates = await Booking.find({ restaurantId, ...extra }).sort({ createdAt: -1 }).limit(150);
  return candidates.find((candidate) => matchPhone(candidate.customerPhone, phone)) || null;
};

exports.confirmPaymentProof = async (req, res) => {
  try {
    if (!requireN8nKey(req, res)) return;
    const restaurantId = String(req.body.restaurantId || "restaurant-1").trim();
    const phone = digitsOnly(req.body.customerPhone || req.body.fromNumber);
    const language = detectLanguage(req.body.message, req.body.customerLanguage || "en");
    if (phone.length < 7) return res.status(400).json({ success: false, message: "A valid customerPhone is required" });
    const [standard, events] = await Promise.all([
      Booking.find({ restaurantId, status: { $in: ["pending", "pending_payment_verification"] }, paymentStatus: { $in: ["proof_received", "verifying"] }, paymentProofConfirmedByCustomer: { $ne: true } }).sort({ createdAt: -1 }).limit(100),
      WeddingBooking.find({ restaurantId, bookingType: { $in: ["wedding", "corporate"] }, paymentVerified: false, paymentStatus: "proof_received", stage: "cs_verification", paymentProofConfirmedByCustomer: { $ne: true } }).sort({ createdAt: -1 }).limit(100),
    ]);
    const matches = [
      ...standard.filter((item) => matchPhone(item.customerPhone, phone)).map((item) => ({ booking: item, type: "standard" })),
      ...events.filter((item) => matchPhone(item.customerPhone, phone)).map((item) => ({ booking: item, type: item.bookingType })),
    ].sort((a, b) => b.booking.createdAt - a.booking.createdAt);
    const match = matches[0];
    if (!match) return res.json({ success: true, data: { active: false, replyText: "" } });
    const booking = match.booking;
    const text = String(req.body.message || "").trim();
    const affirmative = /^(yes|yeah|yep|haan|han|ji|confirm|confirmed|bilkul|theek hai|sahi hai|ہاں|جی|تصدیق ہے|بالکل)[.!،۔\s]*$/i.test(text);
    const negative = /^(no|nope|nahi|nahin|nahi hai|galat|wrong|not mine|نہیں|غلط)[.!،۔\s]*$/i.test(text);
    if (!affirmative && !negative) return res.json({ success: true, data: { active: false, replyText: "" } });
    if (negative) {
      booking.paymentProofConfirmedByCustomer = false;
      booking.customerLanguage = language;
      await booking.save();
      const replyText = language === "ur"
        ? "ٹھیک ہے، براہِ کرم درست ادائیگی کی رسید یا اسکرین شاٹ بھیج دیں۔ موجودہ بکنگ ادائیگی کی تصدیق تک زیرِ التوا رہے گی۔"
        : language === "roman"
          ? "Theek hai, meherbani karke sahi payment receipt ya screenshot bhej dein. Booking payment verify hone tak pending rahegi."
          : "Understood. Please send the correct payment receipt or screenshot. The booking will remain pending until payment is verified.";
      return res.json({ success: true, data: { active: true, replyText, bookingType: match.type } });
    }
    if (match.type === "standard") {
      booking.status = "pending_payment_verification";
      booking.paymentStatus = "verifying";
    }
    booking.paymentProofConfirmedByCustomer = true;
    booking.customerLanguage = language;
    await booking.save();
    if (match.type === "standard") emitBooking(req, "booking_updated", booking);
    else if (match.type === "wedding") req.app.get("io")?.to("chat-admins").emit("wedding_booking_updated", { bookingId: booking._id, restaurantId, booking });
    else req.app.get("io")?.to("chat-admins").emit("corporate_booking_updated", { bookingId: booking._id, restaurantId, booking });
    let warning = "";
    let notificationSkipped = false;
    try {
      const notifyResult = await notifyCsTeam({
        caption: match.type === "standard" ? csPaymentCaption(booking) : eventPaymentCaption(booking, match.type),
        mediaUrl: match.type === "standard" ? booking.paymentScreenshotUrl : booking.paymentProofUrl,
        mediaType: "image",
        restaurantId,
        scheduleType: "payment_alert",
      });
      notificationSkipped = notifyResult === null;
      warning = notifyResult || "";
    } catch (error) {
      warning = `Proof was saved, but the CS WhatsApp notification failed: ${error.response?.data?.error?.message || error.message}`;
      console.error(warning);
    }
    const customerReply = warning
      ? customerCsNotifyFailureText(language)
      : notificationSkipped ? proofSavedForSupportHoursText(language) : customerWaitText(language);
    res.json({ success: true, data: { active: true, booking, replyText: customerReply, bookingType: match.type }, ...(warning ? { warning } : {}) });
  } catch (error) {
    console.error("confirmPaymentProof error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.declineAdvancePayment = async (req, res) => {
  try {
    if (!requireN8nKey(req, res)) return;
    const restaurantId = String(req.body.restaurantId || "restaurant-1").trim();
    const phone = digitsOnly(req.body.customerPhone || req.body.fromNumber);
    const policy = await getBookingPaymentPolicy(restaurantId);
    const language = detectLanguage(req.body.message, req.body.customerLanguage || "en");
    if (phone.length < 7) return res.status(400).json({ success: false, message: "A valid customerPhone is required" });
    const pendingBooking = await findLatestForPhone(restaurantId, phone, {
      status: "pending",
      paymentStatus: { $in: ["unpaid", "payment_declined"] },
    });
    const advancePercent = Number(pendingBooking?.advancePercent ?? policy.advancePercent);
    const reason = String(req.body.reason || req.body.message || `Customer did not agree to pay the ${advancePercent}% advance.`).trim().slice(0, 500);
    if (advancePercent === 0) {
      const replyText = language === "ur"
        ? "اس بکنگ کے لیے ایڈوانس درکار نہیں؛ اسٹاف بکنگ کی تصدیق کرے گا۔"
        : language === "roman"
          ? "Is booking ke liye advance required nahi; staff booking confirm karega."
          : "No advance is required for this booking; staff will confirm it.";
      return res.json({ success: true, data: { active: false, replyText } });
    }
    const message = String(req.body.message || "").trim();
    const explicitPaymentDecline = /\b(?:can't|cannot|cant|won't|will not|unable to|not able to)\s+(?:pay|make payment|send (?:the )?payment|afford)\b|\b(?:payment|advance)\s+(?:is\s+)?(?:not|no)\b|\b(?:payment|advance)\s+nahi\b|payment nahi karna|advance nahi karna/i.test(message)
      || /ادائیگی نہیں|ایڈوانس نہیں|پیسے نہیں دے سکتا|پیسے نہیں دے سکتی/.test(message);
    const generalRefusal = /\b(no|nope|not now|later|not interested|don't want|do not want|too expensive|cash|problem|issue|help|human|agent|can't|cannot|unable)\b/i.test(message)
      || /\b(nahi|nahin|nhi|abhi nahi|baad mein|masla|mushkil|mehnga|madad|insan|insaan|banday se|baat karni)\b/i.test(message)
      || /نہیں|ابھی نہیں|بعد میں|مسئلہ|مہنگا|مدد|انسان/.test(message);
    const phoneTail = phone.slice(-7);
    const phonePattern = new RegExp(phoneTail.split("").join("[^0-9]*") + "$");
    const lastBotMessage = await Chat.findOne({
      restaurantId,
      customerPhone: { $regex: phonePattern },
      botReply: { $ne: "" },
    }).sort({ createdAt: -1 }).select("botReply createdAt").lean();
    const recentPaymentRequest = lastBotMessage
      && Date.now() - new Date(lastBotMessage.createdAt).getTime() <= 7 * 24 * 60 * 60 * 1000
      && /\b(20\s*%|advance|payment|pay|account|transfer|deposit)\b|ادائیگی|ایڈوانس|پیسے|رقم/i.test(lastBotMessage.botReply);
    const declined = explicitPaymentDecline || (generalRefusal && recentPaymentRequest);
    if (!declined) return res.json({ success: true, data: { active: false, replyText: "" } });
    const booking = pendingBooking;
    if (!booking) return res.json({ success: true, data: { active: false, replyText: "" } });
    booking.paymentStatus = "payment_declined";
    booking.paymentDeclineReason = reason;
    booking.customerLanguage = language;
    await booking.save();
    emitBooking(req, "booking_updated", booking);
    let warning = "";
    let notificationSkipped = false;
    try {
      const notifyResult = await notifyCsTeam({ caption: csDeclineCaption(booking, reason), restaurantId, scheduleType: "payment_alert" });
      notificationSkipped = notifyResult === null;
      warning = notifyResult || "";
    } catch (error) {
      warning = `Saved in CRM, but the CS WhatsApp notification failed: ${error.response?.data?.error?.message || error.message}`;
      console.error(warning);
    }
    const customerReply = warning
      ? customerCsNotifyFailureText(language)
      : notificationSkipped ? updateSavedForSupportHoursText(language)
      : language === "ur"
        ? "سمجھ گیا۔ آپ کی تفصیلات محفوظ ہیں۔ ہماری ٹیم جلد آپ سے رابطہ کرے گی۔"
        : language === "roman"
          ? "Samajh gaya. Aapki details save hain. Hamari team jald aapse rabta karegi."
          : "Understood. Your details are saved. Our team will contact you shortly.";
    res.json({ success: true, data: { active: true, booking, replyText: customerReply }, ...(warning ? { warning } : {}) });
  } catch (error) {
    console.error("declineAdvancePayment error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getCustomerBookingContext = async (req, res) => {
  try {
    if (!requireN8nKey(req, res)) return;
    const restaurantId = String(req.query.restaurantId || "restaurant-1").trim();
    const phone = digitsOnly(req.query.phone || req.query.customerPhone);
    if (phone.length < 7) return res.status(400).json({ success: false, message: "A valid phone is required" });
    const phoneTail = phone.slice(-7);
    const phonePattern = new RegExp(phoneTail.split("").join("[^0-9]*") + "$");
    const [standard, events, bookingPaymentPolicy] = await Promise.all([
      Booking.find({ restaurantId, customerPhone: { $regex: phonePattern } }).sort({ createdAt: -1 }).limit(100).lean(),
      WeddingBooking.find({ restaurantId, customerPhone: { $regex: phonePattern } }).sort({ createdAt: -1 }).limit(100).lean(),
      getBookingPaymentPolicy(restaurantId),
    ]);
    const bookings = standard.filter((item) => matchPhone(item.customerPhone, phone)).slice(0, 8).map((item) => ({
      type: "standard",
      id: String(item._id),
      customerName: item.customerName,
      customerPhone: item.customerPhone,
      handledBy: item.handledBy || "whatsapp-bot",
      bookingSource: item.bookingSource,
      status: item.status,
      paymentStatus: item.paymentStatus,
      paymentVerified: ["advance_received", "paid"].includes(item.paymentStatus),
      category: item.bookingCategory || item.package,
      package: item.package,
      selectedItems: item.selectedItems || [],
      bookingDetails: item.bookingDetails || [],
      date: item.bookingDate,
      time: item.bookingTime,
      guests: item.numberOfPersons,
      totalAmount: item.totalAmount,
      advanceAmount: item.advanceAmount,
      advancePercent: item.advancePercent,
      paymentDeadlineAt: item.paymentDeadlineAt || null,
      paymentProofOnFile: Boolean(item.paymentScreenshotUrl),
      csRemarks: item.csRemarks || "",
      paymentDeclineReason: item.paymentDeclineReason || "",
      createdAt: item.createdAt,
    }));
    const eventBookings = events.filter((item) => matchPhone(item.customerPhone, phone)).slice(0, 8).map((item) => ({
      type: item.bookingType || "wedding",
      id: String(item._id),
      customerName: item.customerName,
      customerPhone: item.customerPhone,
      stage: item.stage,
      paymentStatus: item.paymentStatus,
      paymentVerified: Boolean(item.paymentVerified),
      status: item.stage,
      category: item.bookingType === "corporate" ? "Corporate" : "Wedding Package",
      package: item.selectedMenuName || item.packageName || "",
      details: item.answers || {},
      hallName: item.hallName || "",
      date: item.acceptedAlternateDate || item.answers?.weddingDate || item.answers?.eventDate || "",
      guests: item.quotation?.guests || item.answers?.guests || null,
      totalAmount: item.quotation?.total || 0,
      advanceAmount: item.quotation?.advanceRequired || 0,
      advancePercent: item.quotation?.advancePercent ?? item.advancePercent,
      paymentDeadlineAt: item.paymentDeadlineAt || null,
      paymentProofOnFile: Boolean(item.paymentProofUrl),
      agreementRequired: true,
      agreementSaved: Boolean(item.agreementUrl),
      createdAt: item.createdAt,
    }));
    const latest = [...bookings, ...eventBookings].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    const hasPaymentDecline = bookings.some((item) => item.paymentStatus === "payment_declined" || item.paymentDeclineReason);
    const currentPaymentInstructions = paymentInstructions({ advancePercent: bookingPaymentPolicy.advancePercent });
    res.json({
      success: true,
      data: {
        phone,
        bookings,
        eventBookings,
        bookingPaymentPolicy,
        hasPaymentDecline,
        // Configured company payment details, so the bot can repeat them exactly when asked.
        paymentInstructions: currentPaymentInstructions.configured ? currentPaymentInstructions : null,
        instruction: latest
          ? `This customer already has CRM records. Never say they have not booked, not paid, or must provide booking details again if a matching record shows otherwise. Latest: ${latest.category} · status ${latest.status} · payment ${latest.paymentStatus} · handled by ${latest.handledBy || "CRM team"}.`
          : "No saved CRM booking for this phone yet.",
      },
    });
  } catch (error) {
    console.error("getCustomerBookingContext error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Shared with the agent-request controller (hand-off alerts to the CS team).
exports.notifyCsTeam = notifyCsTeam;

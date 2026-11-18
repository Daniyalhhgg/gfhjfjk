const Booking = require("../models/Booking");
const WeddingBooking = require("../models/WeddingBooking");
const { publishDashboardNotification } = require("./dashboardNotificationService");
const { sendWhatsAppText } = require("./whatsappText");

let running = false;

const customerDeadlineMessage = (booking, cancelled) => {
  if (!cancelled) return "";
  if (booking.customerLanguage === "roman") {
    return "Payment deadline guzarne ki wajah se aapki unpaid booking cancel kar di gayi hai. Agar aap ab bhi booking chahte hain to humein yahan message kar dein.";
  }
  if (booking.customerLanguage === "ur") {
    return "ادائیگی کی مقررہ مدت گزرنے کی وجہ سے آپ کی غیر ادا شدہ بکنگ منسوخ کر دی گئی ہے۔ اگر آپ اب بھی بکنگ چاہتے ہیں تو ہمیں یہیں پیغام بھیجیں۔";
  }
  return "Your unpaid booking was cancelled because the payment deadline passed. If you still need the booking, message us here and we will help.";
};

async function notifyDeadline(io, booking, cancelled) {
  const packageName = booking.package || booking.selectedMenuName || booking.packageName || "Booking";
  const category = booking.bookingType ? `${booking.bookingType} ` : "";
  return publishDashboardNotification(
    { app: { get: () => io } },
    {
      restaurantId: booking.restaurantId,
      sourceKey: `payment_deadline:${booking._id}:${cancelled ? "cancelled" : "follow-up"}`,
      type: cancelled ? "booking_cancelled" : "payment_deadline",
      title: cancelled ? "Booking cancelled after payment deadline" : "Payment deadline passed",
      message: `${booking.customerName || "Customer"} · ${category}${packageName}`,
      entityType: "booking",
      entityId: String(booking._id),
    },
  );
}

async function cancelStandardBooking(io, booking) {
  const now = new Date();
  const cancelled = await Booking.findOneAndUpdate(
    {
      _id: booking._id,
      status: "pending",
      paymentStatus: { $in: ["unpaid", "payment_declined"] },
      paymentDeadlineAt: { $lte: now },
      paymentDeadlineHandledAt: null,
    },
    {
      $set: {
        status: "cancelled",
        paymentDeadlineHandledAt: now,
        csRemarks: "Automatically cancelled because the configured payment deadline passed.",
      },
    },
    { new: true },
  );
  if (!cancelled) return;
  await notifyDeadline(io, cancelled, true);
  try {
    await sendWhatsAppText(cancelled.customerPhone, customerDeadlineMessage(cancelled, true));
    const Chat = require("../models/Chat");
    await Chat.create({
      restaurantId: cancelled.restaurantId,
      customerPhone: cancelled.customerPhone.replace(/\D/g, ""),
      customerName: cancelled.customerName || "WhatsApp Customer",
      botReply: customerDeadlineMessage(cancelled, true),
      sender: "bot",
      direction: "bot_to_customer",
      source: "booking_payment_deadline",
      status: "sent",
      isBookingRelated: true,
      bookingId: cancelled._id,
    });
  } catch (error) {
    console.error(`Payment-deadline cancellation message failed for booking ${cancelled._id}:`, error.response?.data?.error?.message || error.message);
  }
}

async function cancelEventBooking(io, booking) {
  const now = new Date();
  const cancelled = await WeddingBooking.findOneAndUpdate(
    {
      _id: booking._id,
      stage: "advance_payment",
      paymentVerified: false,
      paymentStatus: { $in: ["unpaid", "rejected"] },
      paymentDeadlineAt: { $lte: now },
      paymentDeadlineHandledAt: null,
    },
    {
      $set: {
        stage: "no_booking",
        awaitingQuotationAgreement: false,
        awaitingAdvancePayment: false,
        paymentDeadlineHandledAt: now,
      },
      $push: {
        stageHistory: {
          stage: "no_booking",
          changedAt: now,
          actorName: "System",
          note: "Automatically closed because the configured payment deadline passed.",
        },
      },
    },
    { new: true },
  );
  if (!cancelled) return;
  await notifyDeadline(io, cancelled, true);
  try {
    const message = customerDeadlineMessage(cancelled, true);
    await sendWhatsAppText(cancelled.customerPhone, message);
    const Chat = require("../models/Chat");
    await Chat.create({
      restaurantId: cancelled.restaurantId,
      customerPhone: cancelled.customerPhone.replace(/\D/g, ""),
      customerName: cancelled.customerName || "WhatsApp Customer",
      botReply: message,
      sender: "bot",
      direction: "bot_to_customer",
      source: "booking_payment_deadline",
      status: "sent",
      isBookingRelated: true,
      metadata: { weddingBookingId: String(cancelled._id), bookingType: cancelled.bookingType },
    });
  } catch (error) {
    console.error(`Payment-deadline cancellation message failed for event booking ${cancelled._id}:`, error.response?.data?.error?.message || error.message);
  }
}

async function processAlertBooking(io, Model, booking) {
  const notification = await notifyDeadline(io, booking, false);
  if (!notification) return;
  await Model.updateOne(
    { _id: booking._id, paymentDeadlineHandledAt: null },
    { $set: { paymentDeadlineHandledAt: new Date() } },
  );
}

async function runDueBookingPaymentDeadlines(io) {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const standardBookings = await Booking.find({
      paymentDeadlineAt: { $lte: now },
      paymentDeadlineHandledAt: null,
      status: "pending",
      paymentStatus: { $in: ["unpaid", "payment_declined"] },
      paymentDeadlineAction: { $in: ["pending_alert", "auto_cancel"] },
    }).sort({ paymentDeadlineAt: 1 }).limit(50);

    for (const booking of standardBookings) {
      if (booking.paymentDeadlineAction === "auto_cancel") await cancelStandardBooking(io, booking);
      else await processAlertBooking(io, Booking, booking);
    }

    const eventBookings = await WeddingBooking.find({
      paymentDeadlineAt: { $lte: now },
      paymentDeadlineHandledAt: null,
      stage: "advance_payment",
      paymentVerified: false,
      paymentStatus: { $in: ["unpaid", "rejected"] },
      paymentDeadlineAction: { $in: ["pending_alert", "auto_cancel"] },
    }).sort({ paymentDeadlineAt: 1 }).limit(50);

    for (const booking of eventBookings) {
      if (booking.paymentDeadlineAction === "auto_cancel") await cancelEventBooking(io, booking);
      else await processAlertBooking(io, WeddingBooking, booking);
    }
  } catch (error) {
    console.error("Booking payment deadline processing failed:", error);
  } finally {
    running = false;
  }
}

module.exports = { runDueBookingPaymentDeadlines };

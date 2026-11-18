const axios = require("axios");
const Chat = require("../models/Chat");
const { buildCustomerCancellationMessage } = require("./bookingCancellation");

async function sendEventBookingCancellation({ req, booking, bookingType, reason }) {
  const message = buildCustomerCancellationMessage(booking.customerLanguage, reason);
  let warning = "";

  try {
    if (!process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN) {
      throw new Error("WhatsApp Cloud API credentials are not configured.");
    }
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to: booking.customerPhone.replace(/\D/g, ""),
      type: "text",
      text: { body: message },
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" } });
    booking.cancellationMessageStatus = "sent";
    booking.cancellationMessageError = "";
  } catch (error) {
    const sendError = error.response?.data?.error?.message || error.message || "WhatsApp cancellation message could not be sent.";
    booking.cancellationMessageStatus = "failed";
    booking.cancellationMessageError = sendError.slice(0, 500);
    warning = `Booking cancelled, but its WhatsApp message failed: ${sendError}. Retry the cancellation message from the booking details.`;
    console.error(`${bookingType} cancellation WhatsApp message failed:`, sendError);
  }

  await booking.save();

  try {
    const chat = await Chat.create({
      restaurantId: booking.restaurantId,
      customerPhone: booking.customerPhone,
      customerName: booking.customerName || "WhatsApp Customer",
      botReply: message,
      sender: "admin",
      direction: "admin_to_customer",
      source: `${bookingType}_booking_cancellation`,
      status: booking.cancellationMessageStatus === "failed" ? "failed" : "sent",
      isBookingRelated: true,
      metadata: {
        [`${bookingType}BookingId`]: String(booking._id),
        bookingType,
        error: booking.cancellationMessageError,
      },
    });
    req.app.get("io")?.to("chat-admins").emit("whatsapp-new-message", {
      phone: booking.customerPhone.replace(/\D/g, ""),
      customerName: booking.customerName,
      botReply: message,
      sender: "admin",
      isBot: false,
      timestamp: chat.createdAt,
      chatId: chat._id,
    });
  } catch (error) {
    const historyError = `Cancellation message history could not be saved: ${error.message}`;
    warning = [warning, historyError].filter(Boolean).join(" ");
    console.error(`${bookingType} cancellation message history save failed:`, error.message);
  }

  return warning;
}

module.exports = { sendEventBookingCancellation };

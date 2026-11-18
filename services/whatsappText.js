const axios = require("axios");

const sendWhatsAppText = async (phone, message) => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials are not configured.");
  }

  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: String(phone || "").replace(/\D/g, ""),
      type: "text",
      text: { body: String(message || "") },
    },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
};

module.exports = { sendWhatsAppText };

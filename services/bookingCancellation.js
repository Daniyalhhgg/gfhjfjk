const buildCustomerCancellationMessage = (language, reason) => {
  const cleanReason = String(reason || "").trim();
  if (language === "roman") {
    return `Aapki booking cancel kar di gayi hai. Wajah: ${cleanReason}`;
  }
  if (language === "ur") {
    return `آپ کی بکنگ منسوخ کر دی گئی ہے۔ وجہ: ${cleanReason}`;
  }
  return `Your booking has been cancelled. Reason: ${cleanReason}`;
};

module.exports = { buildCustomerCancellationMessage };

// Phone helpers shared by the human-handoff features.
const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

// Customers appear as "923001234567", "+92 300 1234567" or "03001234567" in different places,
// so compare them by their last 10 digits.
const phoneKey = (value) => digitsOnly(value).slice(-10);

module.exports = { digitsOnly, phoneKey };

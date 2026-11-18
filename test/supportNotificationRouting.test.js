const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeWhatsappAlertNumbers } = require("../services/supportSettings");

test("normalizes alert-specific WhatsApp numbers and accepts formatted country codes", () => {
  assert.deepEqual(normalizeWhatsappAlertNumbers({
    payment_alert: "+92 300-1234567",
    human_request: "923111234567",
    booking_issue: "",
  }), {
    value: {
      payment_alert: "923001234567",
      human_request: "923111234567",
      booking_issue: "",
    },
  });
});

test("rejects malformed or incomplete WhatsApp alert number settings", () => {
  assert.match(normalizeWhatsappAlertNumbers(null).error, /object/);
  assert.match(normalizeWhatsappAlertNumbers({
    payment_alert: "123",
    human_request: "",
    booking_issue: "",
  }).error, /7 and 15 digits/);
  assert.match(normalizeWhatsappAlertNumbers({
    payment_alert: "",
    human_request: null,
    booking_issue: "",
  }).error, /each alert type/);
});

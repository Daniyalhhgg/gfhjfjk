const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCustomerCancellationMessage } = require("../services/bookingCancellation");

test("cancellation message includes the staff reason in the customer's language", () => {
  assert.equal(
    buildCustomerCancellationMessage("roman", "Payment could not be verified."),
    "Aapki booking cancel kar di gayi hai. Wajah: Payment could not be verified.",
  );
  assert.equal(
    buildCustomerCancellationMessage("ur", "ادائیگی کی تصدیق نہیں ہو سکی۔"),
    "آپ کی بکنگ منسوخ کر دی گئی ہے۔ وجہ: ادائیگی کی تصدیق نہیں ہو سکی۔",
  );
  assert.equal(
    buildCustomerCancellationMessage("en", "Payment could not be verified."),
    "Your booking has been cancelled. Reason: Payment could not be verified.",
  );
});

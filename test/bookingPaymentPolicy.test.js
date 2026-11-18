const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateAdvanceAmount,
  calculatePaymentDeadline,
  deadlinePolicySnapshot,
  policyForCategory,
  setPaymentDeadline,
} = require("../services/bookingPaymentPolicy");

test("advance amount uses the configured percentage, including zero and fractional percentages", () => {
  assert.equal(calculateAdvanceAmount(1000, 20), 200);
  assert.equal(calculateAdvanceAmount(1000, 0), 0);
  assert.equal(calculateAdvanceAmount(1000, 7.5), 75);
});

test("duration deadlines are measured from the booking instant", () => {
  const createdAt = new Date("2026-01-10T02:00:00.000Z");
  assert.equal(
    calculatePaymentDeadline({
      deadlineMode: "duration",
      deadlineDurationValue: 24,
      deadlineDurationUnit: "hours",
    }, createdAt).toISOString(),
    "2026-01-11T02:00:00.000Z",
  );
  assert.equal(
    calculatePaymentDeadline({
      deadlineMode: "duration",
      deadlineDurationValue: 2,
      deadlineDurationUnit: "days",
    }, createdAt).toISOString(),
    "2026-01-12T02:00:00.000Z",
  );
});

test("same-day and next-day deadlines use Pakistan time and roll a past same-day time forward", () => {
  const morning = new Date("2026-01-10T02:00:00.000Z");
  const evening = new Date("2026-01-10T15:00:00.000Z");
  const policy = { deadlineMode: "same_day", deadlineTime: "17:00" };
  assert.equal(calculatePaymentDeadline(policy, morning).toISOString(), "2026-01-10T12:00:00.000Z");
  assert.equal(calculatePaymentDeadline(policy, evening).toISOString(), "2026-01-11T12:00:00.000Z");
  assert.equal(
    calculatePaymentDeadline({ ...policy, deadlineMode: "next_day" }, morning).toISOString(),
    "2026-01-11T12:00:00.000Z",
  );
});

test("deadline policy snapshot preserves the mode, duration, time, and action", () => {
  const policy = {
    deadlineMode: "next_day",
    deadlineDurationValue: 3,
    deadlineDurationUnit: "days",
    deadlineTime: "16:30",
    deadlineAction: "no_action",
    appliesToCategory: false,
  };
  assert.deepEqual(deadlinePolicySnapshot(policy), {
    paymentDeadlineMode: "next_day",
    paymentDeadlineDurationValue: 3,
    paymentDeadlineDurationUnit: "days",
    paymentDeadlineTime: "16:30",
    paymentDeadlineAction: "no_action",
    bookingPaymentPolicyEnabled: false,
  });
});

test("disabled menu categories preserve the legacy 20% advance without a configurable deadline action", () => {
  const policy = {
    advancePercent: 0,
    deadlineMode: "duration",
    deadlineDurationValue: 12,
    deadlineDurationUnit: "hours",
    deadlineAction: "auto_cancel",
    disabledCategories: ["Hi-Tea Buffet"],
  };
  assert.deepEqual(policyForCategory(policy, "Hi-Tea Buffet"), {
    ...policy,
    advancePercent: 20,
    deadlineAction: "no_action",
    appliesToCategory: false,
  });
  assert.equal(policyForCategory(policy, "Dinner Buffet").advancePercent, 0);
  assert.equal(policyForCategory(policy, "A future menu").appliesToCategory, true);
});

test("no-action policies do not create or expose a payment deadline", () => {
  const booking = {};
  setPaymentDeadline(booking, {
    advancePercent: 20,
    deadlineMode: "duration",
    deadlineDurationValue: 24,
    deadlineDurationUnit: "hours",
    deadlineAction: "no_action",
  }, new Date("2026-01-10T02:00:00.000Z"));
  assert.equal(booking.advancePercent, 20);
  assert.equal(booking.paymentDeadlineAt, null);
  assert.equal(booking.paymentDeadlineAction, "no_action");
});

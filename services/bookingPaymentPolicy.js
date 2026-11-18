const Setting = require("../models/Setting");
const Menu = require("../models/Menu");
const MENU_CATEGORIES = require("../config/menuCategories");

const DEFAULT_BOOKING_PAYMENT_POLICY = Object.freeze({
  advancePercent: 20,
  deadlineMode: "duration",
  deadlineDurationValue: 24,
  deadlineDurationUnit: "hours",
  deadlineTime: "17:00",
  deadlineAction: "pending_alert",
});

async function getBookingPaymentPolicy(restaurantId) {
  const setting = await Setting.findOne({ restaurantId }).select("bookingPaymentPolicy").lean();
  return { ...DEFAULT_BOOKING_PAYMENT_POLICY, ...(setting?.bookingPaymentPolicy || {}) };
}

async function getAvailableBookingCategories(restaurantId) {
  const [menuCategories, bookingCategories] = await Promise.all([
    Menu.distinct("category", { restaurantId }),
    Setting.findOne({ restaurantId }).select("bookingPaymentPolicy.disabledCategories").lean(),
  ]);
  return [...new Set([
    ...MENU_CATEGORIES,
    ...menuCategories,
    ...(bookingCategories?.bookingPaymentPolicy?.disabledCategories || []),
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function policyForCategory(policy, category) {
  const disabledCategories = Array.isArray(policy.disabledCategories) ? policy.disabledCategories : [];
  if (!category || !disabledCategories.includes(category)) {
    return { ...policy, appliesToCategory: true };
  }
  return {
    ...policy,
    advancePercent: 20,
    deadlineAction: "no_action",
    appliesToCategory: false,
  };
}

async function getBookingPaymentPolicyForCategory(restaurantId, category) {
  return policyForCategory(await getBookingPaymentPolicy(restaurantId), category);
}

function calculateAdvanceAmount(totalAmount, advancePercent) {
  return Math.round(Number(totalAmount || 0) * Number(advancePercent || 0)) / 100;
}

function pakistanDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value }) => [type, Number(value)]));
}

function calculatePaymentDeadline(policy, now = new Date()) {
  if (policy.deadlineMode === "duration") {
    const multiplier = policy.deadlineDurationUnit === "days" ? 86400000 : 3600000;
    return new Date(now.getTime() + Number(policy.deadlineDurationValue) * multiplier);
  }

  const { year, month, day } = pakistanDateParts(now);
  const [hours, minutes] = String(policy.deadlineTime || "17:00").split(":").map(Number);
  const dayOffset = policy.deadlineMode === "next_day" ? 1 : 0;
  let deadline = new Date(Date.UTC(year, month - 1, day + dayOffset, hours - 5, minutes));

  // If today's selected time already passed, use the next Pakistan-local day.
  if (deadline <= now) deadline = new Date(deadline.getTime() + 86400000);
  return deadline;
}

function setPaymentDeadline(target, policy, now = new Date()) {
  target.advancePercent = policy.advancePercent;
  target.paymentDeadlineAt = policy.deadlineAction === "no_action"
    ? null
    : calculatePaymentDeadline(policy, now);
  target.paymentDeadlineAction = policy.deadlineAction;
  target.paymentDeadlineHandledAt = null;
}

function deadlinePolicySnapshot(policy) {
  return {
    paymentDeadlineMode: policy.deadlineMode,
    paymentDeadlineDurationValue: policy.deadlineDurationValue,
    paymentDeadlineDurationUnit: policy.deadlineDurationUnit,
    paymentDeadlineTime: policy.deadlineTime,
    paymentDeadlineAction: policy.deadlineAction,
    bookingPaymentPolicyEnabled: policy.appliesToCategory !== false,
  };
}

module.exports = {
  DEFAULT_BOOKING_PAYMENT_POLICY,
  getBookingPaymentPolicy,
  getAvailableBookingCategories,
  policyForCategory,
  getBookingPaymentPolicyForCategory,
  calculateAdvanceAmount,
  calculatePaymentDeadline,
  setPaymentDeadline,
  deadlinePolicySnapshot,
};

const mongoose = require("mongoose");

const escalationLevelSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 40 },
  recipientPhone: { type: String, required: true, trim: true, maxlength: 20 },
  delayMinutes: { type: Number, required: true, min: 1, max: 1440 },
}, { _id: false });

const supportDaySchema = new mongoose.Schema({
  day: { type: Number, required: true, min: 0, max: 6 },
  mode: { type: String, enum: ["custom", "all_day", "closed"], default: "custom" },
  startTime: { type: String, default: "10:00", match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
  endTime: { type: String, default: "17:00", match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
}, { _id: false });

const defaultSupportWeeklySchedule = () => Array.from({ length: 7 }, (_, day) => ({
  day,
  mode: "custom",
  startTime: "10:00",
  endTime: "17:00",
}));
const isValidSupportWeeklySchedule = (schedule) => schedule.length === 7 &&
  new Set(schedule.map(({ day }) => day)).size === 7 &&
  schedule.every(({ day }) => Number.isInteger(day) && day >= 0 && day <= 6);

const supportSettingsSchema = new mongoose.Schema({
  restaurantId: { type: String, required: true, unique: true, trim: true },
  supportAvailabilityMode: { type: String, enum: ["scheduled", "always", "unavailable"], default: "scheduled" },
  supportWeeklySchedule: {
    type: [supportDaySchema],
    default: defaultSupportWeeklySchedule,
    validate: (schedule) => schedule.length === 7 &&
      new Set(schedule.map(({ day }) => day)).size === 7 &&
      schedule.every(({ day }) => Number.isInteger(day) && day >= 0 && day <= 6),
  },
  whatsappAlertNumbers: {
    payment_alert: { type: String, default: "", trim: true, maxlength: 15 },
    human_request: { type: String, default: "", trim: true, maxlength: 15 },
    booking_issue: { type: String, default: "", trim: true, maxlength: 15 },
  },
  supportDays: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6], validate: (days) => days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) },
  supportStartTime: { type: String, default: "10:00", match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
  supportEndTime: { type: String, default: "17:00", match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
  supportUnavailableMessage: {
    type: String,
    default: "Our human support team is currently unavailable. I can still help you here.",
    maxlength: 1000,
  },
  requestDetectionEnabled: { type: Boolean, default: true },
  explicitRequestsEnabled: { type: Boolean, default: true },
  customKeywordsEnabled: { type: Boolean, default: true },
  aiHandoffEnabled: { type: Boolean, default: true },
  handoffMessage: {
    type: String,
    default: "Thank you! We're connecting you to a human agent right now. Please hold for just a moment. 🙏",
    maxlength: 1000,
  },
  requestTimeoutEnabled: { type: Boolean, default: false },
  requestTimeoutMinutes: { type: Number, default: 10, min: 1, max: 1440 },
  timeoutMessage: {
    type: String,
    default: "Sorry for the wait. Our support team is busy right now. You can continue chatting with me, and I will help where I can. 🙏",
    maxlength: 1000,
  },
  sendResolutionMessage: { type: Boolean, default: false },
  resolutionMessage: {
    type: String,
    default: "Thank you for contacting our support team! 😊 We have addressed your concern. Is everything working for you now? I’m here if you need any more help.",
    maxlength: 1000,
  },
  escalationLevels: { type: [escalationLevelSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model("SupportSettings", supportSettingsSchema);

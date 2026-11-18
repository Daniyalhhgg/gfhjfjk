const SupportSettings = require("../models/SupportSettings");

const DEFAULT_RESTAURANT = "restaurant-1";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SCHEDULE_TYPES = ["human_request", "booking_alert", "payment_alert"];
const WHATSAPP_ALERT_TYPES = ["payment_alert", "human_request", "booking_issue"];
const DEFAULT_SCHEDULE = () => Array.from({ length: 7 }, (_, day) => ({
  day,
  mode: "custom",
  startTime: "10:00",
  endTime: "17:00",
}));

const normalizeWeeklySchedule = (settings, type = "human_request") => {
  const configuredSchedule = settings.supportSchedules?.[type];
  if (Array.isArray(configuredSchedule) && configuredSchedule.length === 7) {
    return configuredSchedule;
  }
  if (Array.isArray(settings.supportWeeklySchedule) && settings.supportWeeklySchedule.length === 7) {
    return settings.supportWeeklySchedule;
  }
  const days = Array.isArray(settings.supportDays) ? settings.supportDays : [0, 1, 2, 3, 4, 5, 6];
  return DEFAULT_SCHEDULE().map((entry) => ({
    ...entry,
    mode: days.includes(entry.day) ? "custom" : "closed",
    startTime: settings.supportStartTime || "10:00",
    endTime: settings.supportEndTime || "17:00",
  }));
};

const getSupportAvailability = (settings, now = new Date(), type = "human_request") => {
  const mode = ["scheduled", "always", "unavailable"].includes(settings.supportAvailabilityMode)
    ? settings.supportAvailabilityMode
    : "scheduled";
  const schedule = normalizeWeeklySchedule(settings, type);
  const timeParts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const weekday = WEEKDAYS.indexOf(timeParts.weekday);
  const currentTime = `${timeParts.hour}:${timeParts.minute}`;
  const today = schedule.find((entry) => entry.day === weekday) || { mode: "closed" };
  const scheduledAvailable = today.mode === "all_day" ||
    (today.mode === "custom" && currentTime >= today.startTime && currentTime < today.endTime);
  const available = mode === "always" || (mode === "scheduled" && scheduledAvailable);
  const hoursText = mode === "always"
    ? "24 hours a day, every day"
    : mode === "unavailable"
      ? "currently unavailable"
      : today.mode === "all_day"
        ? `All day on ${WEEKDAYS[weekday]} Pakistan time`
        : today.mode === "custom"
          ? `${WEEKDAYS[weekday]}, ${today.startTime}–${today.endTime} Pakistan time`
          : `${WEEKDAYS[weekday]} is closed`;
  return {
    mode,
    available,
    currentTime,
    weekday,
    year: Number(timeParts.year),
    month: Number(timeParts.month),
    day: Number(timeParts.day),
    schedule,
    today,
    hoursText,
  };
};

const isSupportTypeAvailable = (settings, type, now = new Date()) => {
  const scheduleType = type === "booking_issue" ? "booking_alert" : type;
  if (scheduleType !== "human_request") return true;
  const availability = getSupportAvailability(settings, now, scheduleType);
  if (availability.mode === "always") return true;
  if (availability.mode === "unavailable") return false;
  return availability.available;
};

const getNextSupportOpening = (settings, now = new Date(), type = "human_request") => {
  const scheduleType = type === "booking_issue" ? "booking_alert" : type;
  const availability = getSupportAvailability(settings, now, scheduleType);
  if (availability.mode === "unavailable") return null;
  if (availability.mode === "always" || isSupportTypeAvailable(settings, type, now)) return now;
  for (let offset = 0; offset <= 7; offset++) {
    const localDate = new Date(Date.UTC(availability.year, availability.month - 1, availability.day + offset));
    const day = availability.schedule.find((entry) => entry.day === localDate.getUTCDay());
    if (!day || day.mode === "closed") continue;
    const [hours, minutes] = (day.mode === "all_day" ? "00:00" : day.startTime).split(":").map(Number);
    const opening = new Date(Date.UTC(
      localDate.getUTCFullYear(),
      localDate.getUTCMonth(),
      localDate.getUTCDate(),
      hours - 5,
      minutes,
    ));
    if (opening > now) return opening;
  }
  return null;
};

const DEFAULT_SETTINGS = {
  supportAvailabilityMode: "scheduled",
  supportDays: [0, 1, 2, 3, 4, 5, 6],
  supportStartTime: "10:00",
  supportEndTime: "17:00",
  supportWeeklySchedule: DEFAULT_SCHEDULE(),
  whatsappAlertNumbers: {
    payment_alert: "",
    human_request: "",
    booking_issue: "",
  },
  supportUnavailableMessage: "Our human support team is currently unavailable. I can still help you here.",
  requestDetectionEnabled: true,
  explicitRequestsEnabled: true,
  customKeywordsEnabled: true,
  aiHandoffEnabled: true,
  handoffMessage: "Thank you! We're connecting you to a human agent right now. Please hold for just a moment. 🙏",
  requestTimeoutEnabled: false,
  requestTimeoutMinutes: 10,
  timeoutMessage: "Sorry for the wait. Our support team is busy right now. You can continue chatting with me, and I will help where I can. 🙏",
  sendResolutionMessage: false,
  resolutionMessage: "Thank you for contacting our support team! 😊 We have addressed your concern. Is everything working for you now? I’m here if you need any more help.",
  escalationLevels: [],
};

const getSupportSettings = async (restaurantId = DEFAULT_RESTAURANT) => {
  const settings = await SupportSettings.findOne({ restaurantId }).lean();
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  merged.supportWeeklySchedule = normalizeWeeklySchedule(merged, "human_request");
  merged.whatsappAlertNumbers = {
    ...DEFAULT_SETTINGS.whatsappAlertNumbers,
    ...(settings?.whatsappAlertNumbers || {}),
  };
  return merged;
};

const normalizeWhatsappAlertNumbers = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "WhatsApp alert numbers must be provided as an object." };
  }
  const value = {};
  for (const type of WHATSAPP_ALERT_TYPES) {
    if (typeof input[type] !== "string") {
      return { error: "Enter a WhatsApp number for each alert type, or leave it blank." };
    }
    const number = input[type].replace(/\D/g, "");
    if (number && (number.length < 7 || number.length > 15)) {
      return { error: "WhatsApp numbers must contain between 7 and 15 digits." };
    }
    value[type] = number;
  }
  return { value };
};

module.exports = {
  getSupportSettings,
  getSupportAvailability,
  isSupportTypeAvailable,
  getNextSupportOpening,
  DEFAULT_RESTAURANT,
  SCHEDULE_TYPES,
  WHATSAPP_ALERT_TYPES,
  normalizeWhatsappAlertNumbers,
  DEFAULT_SCHEDULE,
};

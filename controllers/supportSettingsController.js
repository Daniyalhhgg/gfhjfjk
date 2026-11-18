const SupportSettings = require("../models/SupportSettings");
const {
  getSupportSettings,
  getSupportAvailability,
  isSupportTypeAvailable,
  DEFAULT_RESTAURANT,
  SCHEDULE_TYPES,
  normalizeWhatsappAlertNumbers,
} = require("../services/supportSettings");
const { detectHumanRequest } = require("../services/handoffDetection");
const { getCustomHandoffKeywords } = require("../services/handoffKeywords");
const AgentRequest = require("../models/AgentRequest");

const cleanMessage = (value, fallback) => {
  const message = String(value ?? fallback).trim();
  return message.length <= 1000 ? message : null;
};

const defaultWeeklySchedule = () => Array.from({ length: 7 }, (_, day) => ({
  day,
  mode: "custom",
  startTime: "10:00",
  endTime: "17:00",
}));

const normalizeWeeklySchedule = (schedule, label) => {
  if (!Array.isArray(schedule) || schedule.length !== 7) {
    return { error: `${label} must contain one entry for every weekday` };
  }
  const normalized = [];
  for (const [index, rawDay] of schedule.entries()) {
    const { day, mode, startTime, endTime } = rawDay || {};
    if (!Number.isInteger(day) || day < 0 || day > 6 ||
      !["custom", "all_day", "closed"].includes(mode) ||
      normalized.some((entry) => entry.day === day)) {
      return { error: `${label} entry ${index + 1} has an invalid or duplicate weekday or mode` };
    }
    if (mode === "custom" && (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime) || startTime >= endTime)) {
      return { error: `${label} entry ${index + 1} must have valid hours with opening before closing` };
    }
    normalized.push({
      day,
      mode,
      startTime: mode === "custom" ? startTime : "10:00",
      endTime: mode === "custom" ? endTime : "17:00",
    });
  }
  return { value: normalized.sort((a, b) => a.day - b.day) };
};

const normalizeSupportSchedules = (body) => {
  if (body.supportWeeklySchedule !== undefined && !Array.isArray(body.supportWeeklySchedule)) {
    return { error: "supportWeeklySchedule must be an array" };
  }
  if (body.supportSchedules !== undefined &&
    (!body.supportSchedules || typeof body.supportSchedules !== "object" || Array.isArray(body.supportSchedules))) {
    return { error: "supportSchedules must contain the human-support schedule" };
  }
  const legacyDays = Array.isArray(body.supportDays) ? body.supportDays : [0, 1, 2, 3, 4, 5, 6];
  const legacySchedule = body.supportWeeklySchedule || body.supportSchedules?.human_request || defaultWeeklySchedule().map((entry) => ({
    ...entry,
    mode: legacyDays.includes(entry.day) ? "custom" : "closed",
    startTime: body.supportStartTime || "10:00",
    endTime: body.supportEndTime || "17:00",
  }));
  const parsedLegacy = normalizeWeeklySchedule(legacySchedule, "supportWeeklySchedule");
  if (parsedLegacy.error) return parsedLegacy;

  if (body.supportScheduleTypes !== undefined && !Array.isArray(body.supportScheduleTypes)) {
    return { error: "supportScheduleTypes must be an array" };
  }
  const legacyTypes = body.supportScheduleTypes ?? SCHEDULE_TYPES;
  if (legacyTypes.some((type) => !SCHEDULE_TYPES.includes(type)) || new Set(legacyTypes).size !== legacyTypes.length) {
    return { error: "supportScheduleTypes must contain unique supported alert types" };
  }
  return { value: parsedLegacy.value };
};

const normalizePayload = (body) => {
  if (!["scheduled", "always", "unavailable"].includes(body.supportAvailabilityMode)) {
    return { error: "supportAvailabilityMode must be scheduled, always, or unavailable" };
  }
  const supportSchedules = normalizeSupportSchedules(body);
  if (supportSchedules.error) return supportSchedules;
  const fields = [
    "requestDetectionEnabled",
    "explicitRequestsEnabled",
    "customKeywordsEnabled",
    "aiHandoffEnabled",
    "requestTimeoutEnabled",
    "sendResolutionMessage",
  ];
  for (const field of fields) {
    if (typeof body[field] !== "boolean") return { error: `${field} must be a boolean` };
  }
  const timeout = Number(body.requestTimeoutMinutes);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1440) {
    return { error: "requestTimeoutMinutes must be between 1 and 1440" };
  }
  const messages = {
    supportUnavailableMessage: cleanMessage(body.supportUnavailableMessage, "Our human support team is currently unavailable. I can still help you here."),
    handoffMessage: cleanMessage(body.handoffMessage, ""),
    timeoutMessage: cleanMessage(body.timeoutMessage, ""),
    resolutionMessage: cleanMessage(body.resolutionMessage, ""),
  };
  if (Object.values(messages).some((message) => message === null)) {
    return { error: "Support messages must not exceed 1000 characters" };
  }
  if (!Array.isArray(body.escalationLevels) || body.escalationLevels.length > 5) {
    return { error: "escalationLevels must contain no more than 5 levels" };
  }
  const escalationLevels = [];
  for (const [index, rawLevel] of body.escalationLevels.entries()) {
    const name = String(rawLevel?.name || "").trim();
    const recipientPhone = String(rawLevel?.recipientPhone || "").replace(/\D/g, "");
    const delayMinutes = Number(rawLevel?.delayMinutes);
    if (!name || name.length > 40 || recipientPhone.length < 7 || recipientPhone.length > 15 ||
      !Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 1440) {
      return { error: `Escalation level ${index + 1} has invalid name, phone, or delay` };
    }
    if (index > 0 && delayMinutes <= escalationLevels[index - 1].delayMinutes) {
      return { error: "Escalation delays must increase at every level" };
    }
    escalationLevels.push({ name, recipientPhone, delayMinutes });
  }
  return {
    value: {
      ...fields.reduce((result, field) => ({ ...result, [field]: body[field] }), {}),
      supportAvailabilityMode: body.supportAvailabilityMode,
      supportWeeklySchedule: supportSchedules.value,
      requestTimeoutMinutes: timeout,
      ...messages,
      escalationLevels,
    },
  };
};

exports.getSettings = async (req, res) => {
  try {
    const data = await getSupportSettings(req.admin.restaurantId || DEFAULT_RESTAURANT);
    res.json({ success: true, data });
  } catch (error) {
    console.error("Could not load support settings:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.saveSettings = async (req, res) => {
  try {
    const parsed = normalizePayload(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const restaurantId = req.admin.restaurantId || DEFAULT_RESTAURANT;
    const settings = await SupportSettings.findOneAndUpdate(
      { restaurantId },
      { $set: parsed.value },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    const openRequests = await AgentRequest.find({ restaurantId, status: "open" })
      .select("_id createdAt escalationLevel")
      .limit(500)
      .lean();
    await Promise.all(openRequests.map((request) => {
      const currentLevel = Math.max(1, Number(request.escalationLevel || 0));
      const nextLevel = parsed.value.escalationLevels[currentLevel];
      return AgentRequest.updateOne(
        { _id: request._id, status: "open" },
        {
          $set: {
            timeoutAt: parsed.value.requestTimeoutEnabled
              ? new Date(new Date(request.createdAt).getTime() + parsed.value.requestTimeoutMinutes * 60000)
              : null,
            escalationLevel: nextLevel ? currentLevel : parsed.value.escalationLevels.length,
            nextEscalationAt: nextLevel
              ? new Date(new Date(request.createdAt).getTime() + nextLevel.delayMinutes * 60000)
              : null,
          },
        }
      );
    }));
    res.json({ success: true, data: settings.toObject() });
  } catch (error) {
    console.error("Could not save support settings:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.saveWhatsappAlertNumbers = async (req, res) => {
  try {
    const parsed = normalizeWhatsappAlertNumbers(req.body?.whatsappAlertNumbers);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const restaurantId = req.admin.restaurantId || DEFAULT_RESTAURANT;
    const settings = await SupportSettings.findOneAndUpdate(
      { restaurantId },
      { $set: { whatsappAlertNumbers: parsed.value } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    res.json({ success: true, data: settings.whatsappAlertNumbers });
  } catch (error) {
    console.error("Could not save WhatsApp alert numbers:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.evaluateHandoff = async (req, res) => {
  try {
    if (!process.env.N8N_API_KEY || req.get("x-api-key") !== process.env.N8N_API_KEY) {
      return res.status(401).json({ success: false, message: "Invalid API key" });
    }
    const phone = String(req.body.phone || "").replace(/\D/g, "");
    const message = String(req.body.message || "").trim();
    if (phone.length < 7 || !message || message.length > 5000) {
      return res.status(400).json({ success: false, message: "A valid phone and message are required" });
    }
    const restaurantId = String(req.body.restaurantId || DEFAULT_RESTAURANT).trim();
    const settings = await getSupportSettings(restaurantId);
    const customWords = settings.customKeywordsEnabled
      ? await getCustomHandoffKeywords(restaurantId)
      : [];
    const match = settings.requestDetectionEnabled
      ? detectHumanRequest(message, customWords, {
        includeBuiltIn: settings.explicitRequestsEnabled,
        includeCustom: settings.customKeywordsEnabled,
      })
      : null;
    const supportAvailability = getSupportAvailability(settings);
    res.json({
      success: true,
      matched: Boolean(match),
      humanHandoffAvailable: isSupportTypeAvailable(settings, "human_request"),
      supportAvailability,
      supportUnavailableMessage: settings.supportUnavailableMessage,
      keyword: match?.keyword || "",
      aiHandoffEnabled: settings.aiHandoffEnabled,
      handoffMessage: settings.handoffMessage,
      humanRequestWhatsappNumber: settings.whatsappAlertNumbers?.human_request
        ? `+${settings.whatsappAlertNumbers.human_request}`
        : "",
      firstEscalationPhone: settings.escalationLevels[0]?.recipientPhone
        ? `+${settings.escalationLevels[0].recipientPhone}`
        : "",
    });
  } catch (error) {
    console.error("Could not evaluate dynamic handoff rules:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

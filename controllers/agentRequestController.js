const mongoose = require("mongoose");
const AgentRequest = require("../models/AgentRequest");
const HumanModeState = require("../models/HumanModeState");
const HandoffKeyword = require("../models/HandoffKeyword");
const { phoneKey, digitsOnly } = require("../utils/phone");
const {
  detectHumanRequest,
  DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION,
} = require("../services/handoffDetection");
const { publishDashboardNotification } = require("../services/dashboardNotificationService");
const { getSupportSettings, getSupportAvailability, isSupportTypeAvailable } = require("../services/supportSettings");
const { getCustomHandoffKeywords } = require("../services/handoffKeywords");
const { sendWhatsAppText } = require("../services/whatsappText");

const MAX_MESSAGES = 8;
const DEFAULT_RESTAURANT = "restaurant-1";

const toClient = (doc) => {
  const item = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(item._id),
    phone: item.customerPhone,
    name: item.customerName || "",
    type: item.reason === "bot_handoff" ? "bot" : "human",
    keyword: item.keyword || "",
    priority: item.priority,
    status: item.status,
    message: item.firstMessage || item.lastMessage || "",
    lastMessage: item.lastMessage || "",
    createdAt: item.createdAt,
    lastAt: item.lastAt || item.updatedAt,
    count: item.count || 1,
    seen: Boolean(item.seen),
    messages: (item.messages || []).map((message) => ({ from: message.from, text: message.text, at: message.at })),
    takenAt: item.takenAt || null,
    resolvedAt: item.resolvedAt || null,
    expiredAt: item.expiredAt || null,
    timeoutAt: item.timeoutAt || null,
    nextEscalationAt: item.nextEscalationAt || null,
    escalationLevel: item.escalationLevel || 0,
  };
};

const emitRequest = (io, event, doc) => {
  if (io) io.to("chat-admins").emit(event, { request: toClient(doc) });
};

const pushMessage = (doc, from, text) => {
  if (!text) return;
  doc.messages.push({ from, text: String(text).slice(0, 1000), at: new Date() });
  if (doc.messages.length > MAX_MESSAGES) doc.messages = doc.messages.slice(-MAX_MESSAGES);
};

const setHumanMode = async (phone, on) => {
  await HumanModeState.findOneAndUpdate(
    { phoneKey: phoneKey(phone) },
    { $set: { on: Boolean(on), phone: digitsOnly(phone) } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

const requestDeadlines = (settings, createdAt = new Date()) => {
  const timeoutAt = settings.requestTimeoutEnabled
    ? new Date(new Date(createdAt).getTime() + settings.requestTimeoutMinutes * 60000)
    : null;
  const nextLevelIndex = 1;
  const nextLevel = settings.escalationLevels[nextLevelIndex];
  return {
    timeoutAt,
    escalationLevel: nextLevel ? nextLevelIndex : settings.escalationLevels.length,
    nextEscalationAt: nextLevel
      ? new Date(new Date(createdAt).getTime() + nextLevel.delayMinutes * 60000)
      : null,
  };
};

/**
 * Create a new agent request for a customer, or add to the one that is already open/taken.
 * Used by the n8n hand-off route and by the chat logger when a customer asks for a person.
 */
async function upsertAgentRequest({ io, restaurantId = DEFAULT_RESTAURANT, phone, name = "", text = "", reason = "human_requested", keyword = "", priority = "high" }) {
  const key = phoneKey(phone);
  if (key.length < 7) return null;

  const existing = await AgentRequest.findOne({ restaurantId, phoneKey: key, status: { $in: ["open", "taken"] } }).sort({ createdAt: -1 });
  if (!existing) {
    const settings = await getSupportSettings(restaurantId);
    const supportAvailability = getSupportAvailability(settings);
    if (!isSupportTypeAvailable(settings, "human_request")) {
      return { request: null, created: false, unavailable: true, availability: supportAvailability };
    }
  }
  if (existing) {
    if (text) {
      existing.lastMessage = String(text).slice(0, 1000);
      pushMessage(existing, "customer", text);
    }
    existing.lastAt = new Date();
    if (name && !existing.customerName) existing.customerName = name;
    if (existing.status === "open") {
      existing.count += 1;
      existing.seen = false;
    }
    await existing.save();
    emitRequest(io, "agent-request-updated", existing);
    return { request: existing, created: false };
  }

  const settings = await getSupportSettings(restaurantId);
  const deadlines = requestDeadlines(settings);
  const created = await AgentRequest.create({
    restaurantId,
    customerPhone: digitsOnly(phone),
    phoneKey: key,
    customerName: name,
    reason,
    keyword,
    priority,
    firstMessage: String(text || "").slice(0, 1000),
    lastMessage: String(text || "").slice(0, 1000),
    messages: text ? [{ from: "customer", text: String(text).slice(0, 1000), at: new Date() }] : [],
    ...deadlines,
  });
  emitRequest(io, "agent-request-created", created);
  try {
    await publishDashboardNotification({ app: { get: () => io } }, {
      restaurantId,
      sourceKey: `handoff:${created._id}`,
      type: "human_agent",
      title: "Customer needs a human agent",
      message: `${name ? `${name} · ` : ""}+${digitsOnly(phone)}${text ? `: ${String(text).slice(0, 800)}` : ""}`,
      entityType: "customer",
      entityId: digitsOnly(phone),
    });
  } catch (error) {
    console.error("Agent request dashboard notification failed:", error.message);
  }
  return { request: created, created: true };
}

/** Called for every logged WhatsApp message: opens a request if the customer asks for a person. */
async function trackCustomerMessage({ io, restaurantId = DEFAULT_RESTAURANT, phone, name, customerMessage, botReply }) {
  const key = phoneKey(phone);
  if (key.length < 7) return;
  if (customerMessage) {
    const settings = await getSupportSettings(restaurantId);
    const customWords = settings.customKeywordsEnabled
      ? await getCustomHandoffKeywords(restaurantId)
      : [];
    const found = settings.requestDetectionEnabled
      ? detectHumanRequest(customerMessage, customWords, {
        includeBuiltIn: settings.explicitRequestsEnabled,
        includeCustom: settings.customKeywordsEnabled,
      })
      : null;
    if (found && isSupportTypeAvailable(settings, "human_request")) {
      await upsertAgentRequest({ io, restaurantId, phone, name, text: customerMessage, reason: "human_requested", keyword: found.keyword, priority: found.priority });
      return;
    }
  }
  // Keep the conversation context on a request that is already open or taken.
  const active = await AgentRequest.findOne({ restaurantId, phoneKey: key, status: { $in: ["open", "taken"] } }).sort({ createdAt: -1 });
  if (!active) return;
  if (customerMessage) { pushMessage(active, "customer", customerMessage); active.lastMessage = String(customerMessage).slice(0, 1000); }
  if (botReply) pushMessage(active, "bot", botReply);
  active.lastAt = new Date();
  await active.save();
  emitRequest(io, "agent-request-updated", active);
}

exports.upsertAgentRequest = upsertAgentRequest;
exports.trackCustomerMessage = trackCustomerMessage;

// ---------------------------------------------------------------- n8n route
exports.createFromWhatsApp = async (req, res) => {
  try {
    if (process.env.N8N_API_KEY && req.get("x-api-key") !== process.env.N8N_API_KEY) {
      return res.status(401).json({ success: false, message: "Invalid API key" });
    }
    const phone = digitsOnly(req.body.phone || req.body.fromNumber);
    if (phone.length < 7) return res.status(400).json({ success: false, message: "A valid phone is required" });
    const result = await upsertAgentRequest({
      io: req.app.get("io"),
      restaurantId: String(req.body.restaurantId || DEFAULT_RESTAURANT).trim(),
      phone,
      name: String(req.body.customerName || "").trim(),
      text: String(req.body.message || "").trim(),
      reason: req.body.reason === "human_requested" ? "human_requested" : "bot_handoff",
      keyword: String(req.body.keyword || "").trim(),
      priority: "high",
    });
    // Optional WhatsApp alert for the CS team (used when the bot could not finish something, e.g. saving a booking).
    let csWarning = "";
    if (result?.created && req.body.notifyCs === true) {
      try {
        const { notifyCsTeam } = require("./bookingController");
        csWarning = await notifyCsTeam({
          caption: [
            "*Customer needs your help*",
            "",
            `WhatsApp: +${digitsOnly(phone)}`,
            req.body.message ? `Details: ${String(req.body.message).slice(0, 500)}` : "",
            "",
            "Open the CRM > Human Agent Requests to take over.",
          ].filter((line, index, list) => line || (index > 0 && list[index - 1])).join("\n"),
          restaurantId: String(req.body.restaurantId || DEFAULT_RESTAURANT).trim(),
          scheduleType: "human_request",
          alertType: req.body.alertType === "booking_issue" ? "booking_issue" : "human_request",
        });
      } catch (error) {
        csWarning = `CS WhatsApp alert failed: ${error.response?.data?.error?.message || error.message}`;
        console.error(csWarning);
      }
    }
    res.status(result?.created ? 201 : 200).json({
      success: true,
      data: result?.request ? toClient(result.request) : null,
      ...(result?.unavailable ? { unavailable: true, supportAvailability: result.availability } : {}),
      ...(csWarning ? { warning: csWarning } : {}),
    });
  } catch (error) {
    console.error("createFromWhatsApp agent request error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createInformationNeededAlert = async (req, res) => {
  try {
    if (!process.env.N8N_API_KEY || req.get("x-api-key") !== process.env.N8N_API_KEY) {
      return res.status(401).json({ success: false, message: "Invalid API key" });
    }
    const phone = digitsOnly(req.body.phone);
    const customerMessage = String(req.body.customerMessage || "").trim();
    const botReply = String(req.body.botReply || "").trim();
    const sourceMessageId = String(req.body.sourceMessageId || "").trim();
    const restaurantId = String(req.body.restaurantId || DEFAULT_RESTAURANT).trim();
    if (phone.length < 7 || !customerMessage || customerMessage.length > 2000 ||
      !botReply || botReply.length > 2000 || !sourceMessageId || sourceMessageId.length > 160) {
      return res.status(400).json({ success: false, message: "A valid phone, customer message, bot reply, and source message ID are required" });
    }
    const notification = await publishDashboardNotification(req, {
      restaurantId,
      sourceKey: `customer-info-needed:${phone}:${sourceMessageId}`,
      type: "customer_info_needed",
      title: "Customer asked for unavailable information",
      message: `WhatsApp: +${phone}\nCustomer: ${customerMessage.slice(0, 700)}\nBot: ${botReply.slice(0, 250)}`,
      entityType: "customer",
      entityId: phone,
    });
    res.status(201).json({
      success: true,
      data: notification,
      notificationSkipped: !notification,
    });
  } catch (error) {
    console.error("Could not create unavailable-information alert:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------- CRM routes
exports.list = async (req, res) => {
  try {
    const items = await AgentRequest.find({ restaurantId: req.admin.restaurantId }).sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, data: items.map(toClient) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const loadOwn = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid request id" });
    return null;
  }
  const doc = await AgentRequest.findOne({ _id: req.params.id, restaurantId: req.admin.restaurantId });
  if (!doc) res.status(404).json({ success: false, message: "Agent request not found" });
  return doc;
};

exports.take = async (req, res) => {
  try {
    const doc = await loadOwn(req, res); if (!doc) return;
    if (doc.status === "resolved" || doc.status === "expired") {
      return res.status(409).json({ success: false, message: "This request is no longer available to take over." });
    }
    const previousStatus = doc.status;
    const updated = await AgentRequest.findOneAndUpdate(
      { _id: doc._id, restaurantId: req.admin.restaurantId, status: previousStatus },
      { $set: { status: "taken", takenAt: new Date(), takenBy: req.admin._id, seen: true } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ success: false, message: "This request changed before it could be taken over." });
    try {
      await setHumanMode(updated.customerPhone, true);
    } catch (error) {
      if (previousStatus === "open") {
        await AgentRequest.updateOne(
          { _id: updated._id, restaurantId: req.admin.restaurantId, status: "taken" },
          { $set: { status: "open", takenAt: null, takenBy: null } }
        );
      }
      throw error;
    }
    req.app.get("io")?.to("chat-admins").emit("human-mode-changed", { phone: updated.customerPhone, humanMode: true });
    emitRequest(req.app.get("io"), "agent-request-updated", updated);
    res.json({ success: true, data: toClient(updated) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.resolve = async (req, res) => {
  try {
    const doc = await loadOwn(req, res); if (!doc) return;
    if (doc.status === "expired") {
      return res.status(409).json({ success: false, message: "This request has expired and cannot be resolved." });
    }
    const settings = await getSupportSettings(req.admin.restaurantId || DEFAULT_RESTAURANT);
    const previousStatus = doc.status;
    const resolvedAt = new Date();
    const updated = await AgentRequest.findOneAndUpdate(
      { _id: doc._id, restaurantId: req.admin.restaurantId, status: previousStatus },
      { $set: { status: "resolved", resolvedAt, seen: true, timeoutAt: null, nextEscalationAt: null } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ success: false, message: "This request changed before it could be resolved." });
    try {
      await setHumanMode(updated.customerPhone, false);
    } catch (error) {
      try {
        await AgentRequest.updateOne(
          { _id: updated._id, restaurantId: req.admin.restaurantId, status: "resolved", resolvedAt },
          {
            $set: {
              status: previousStatus,
              resolvedAt: doc.resolvedAt || null,
              timeoutAt: doc.timeoutAt || null,
              nextEscalationAt: doc.nextEscalationAt || null,
              escalationLevel: doc.escalationLevel || 0,
            },
          }
        );
      } catch (rollbackError) {
        console.error(`Could not restore request ${updated._id} after mode update failed:`, rollbackError);
      }
      throw error;
    }
    req.app.get("io")?.to("chat-admins").emit("human-mode-changed", { phone: updated.customerPhone, humanMode: false });
    emitRequest(req.app.get("io"), "agent-request-updated", updated);
    let deliveryWarning = "";
    if (settings.sendResolutionMessage && settings.resolutionMessage.trim()) {
      let delivered = false;
      try {
        await sendWhatsAppText(updated.customerPhone, settings.resolutionMessage);
        delivered = true;
      } catch (error) {
        deliveryWarning = `Request was resolved, but the customer message could not be sent: ${error.response?.data?.error?.message || error.message}`;
        console.error(deliveryWarning);
      }
      if (delivered) {
        try {
          const Chat = require("../models/Chat");
          const chat = await Chat.create({
            restaurantId: updated.restaurantId,
            customerPhone: digitsOnly(updated.customerPhone),
            customerName: updated.customerName || "WhatsApp Customer",
            customerMessage: "",
            botReply: settings.resolutionMessage,
            sender: "admin",
            direction: "admin_to_customer",
            source: "support_resolution",
          });
          req.app.get("io")?.to("chat-admins").emit("whatsapp-new-message", {
            phone: digitsOnly(updated.customerPhone),
            botReply: settings.resolutionMessage,
            isBot: false,
            sender: "admin",
            source: "support_resolution",
            timestamp: chat.createdAt,
            chatId: chat._id,
          });
        } catch (error) {
          deliveryWarning = `The customer received the resolution message, but it could not be saved in chat history: ${error.message}`;
        }
      }
      if (deliveryWarning) {
        console.error(deliveryWarning);
      }
    }
    res.json({ success: true, data: toClient(updated), ...(deliveryWarning ? { warning: deliveryWarning } : {}) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.reopen = async (req, res) => {
  try {
    const doc = await loadOwn(req, res); if (!doc) return;
    doc.status = "open";
    doc.resolvedAt = null;
    doc.expiredAt = null;
    const settings = await getSupportSettings(req.admin.restaurantId || DEFAULT_RESTAURANT);
    Object.assign(doc, requestDeadlines(settings));
    doc.seen = true;
    await doc.save();
    emitRequest(req.app.get("io"), "agent-request-updated", doc);
    res.json({ success: true, data: toClient(doc) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.markSeen = async (req, res) => {
  try {
    const doc = await loadOwn(req, res); if (!doc) return;
    doc.seen = true;
    await doc.save();
    res.json({ success: true, data: toClient(doc) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.remove = async (req, res) => {
  try {
    const doc = await loadOwn(req, res); if (!doc) return;
    await doc.deleteOne();
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.clearResolved = async (req, res) => {
  try {
    const result = await AgentRequest.deleteMany({ restaurantId: req.admin.restaurantId, status: "resolved" });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getKeywords = async (req, res) => {
  try {
    const words = await getCustomHandoffKeywords(req.admin.restaurantId);
    res.json({ success: true, data: words });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.setKeywords = async (req, res) => {
  try {
    const words = Array.isArray(req.body.words)
      ? [...new Set(req.body.words.map((word) => String(word || "").trim().toLowerCase()).filter((word) => word && word.length <= 60))].slice(0, 100)
      : null;
    if (!words) return res.status(400).json({ success: false, message: "words must be an array" });
    await HandoffKeyword.findOneAndUpdate(
      { restaurantId: req.admin.restaurantId },
      { $set: { words, defaultsVersion: DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, data: words });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

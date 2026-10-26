const mongoose = require("mongoose");
const AgentRequest = require("../models/AgentRequest");
const HumanModeState = require("../models/HumanModeState");
const HandoffKeyword = require("../models/HandoffKeyword");
const { phoneKey, digitsOnly } = require("../utils/phone");
const { detectHumanRequest } = require("../services/handoffDetection");
const { publishDashboardNotification } = require("../services/dashboardNotificationService");

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

/**
 * Create a new agent request for a customer, or add to the one that is already open/taken.
 * Used by the n8n hand-off route and by the chat logger when a customer asks for a person.
 */
async function upsertAgentRequest({ io, restaurantId = DEFAULT_RESTAURANT, phone, name = "", text = "", reason = "human_requested", keyword = "", priority = "high" }) {
  const key = phoneKey(phone);
  if (key.length < 7) return null;

  const existing = await AgentRequest.findOne({ restaurantId, phoneKey: key, status: { $in: ["open", "taken"] } }).sort({ createdAt: -1 });
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
    const keywordDoc = await HandoffKeyword.findOne({ restaurantId }).lean();
    const found = detectHumanRequest(customerMessage, keywordDoc?.words || []);
    if (found) {
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
        });
      } catch (error) {
        csWarning = `CS WhatsApp alert failed: ${error.response?.data?.error?.message || error.message}`;
        console.error(csWarning);
      }
    }
    res.status(result?.created ? 201 : 200).json({ success: true, data: result ? toClient(result.request) : null, ...(csWarning ? { warning: csWarning } : {}) });
  } catch (error) {
    console.error("createFromWhatsApp agent request error:", error);
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
    doc.status = "taken";
    doc.takenAt = new Date();
    doc.takenBy = req.admin._id;
    doc.seen = true;
    await doc.save();
    await setHumanMode(doc.customerPhone, true); // the bot stops replying to this customer
    req.app.get("io")?.to("chat-admins").emit("human-mode-changed", { phone: doc.customerPhone, humanMode: true });
    emitRequest(req.app.get("io"), "agent-request-updated", doc);
    res.json({ success: true, data: toClient(doc) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.resolve = async (req, res) => {
  try {
    const doc = await loadOwn(req, res); if (!doc) return;
    doc.status = "resolved";
    doc.resolvedAt = new Date();
    doc.seen = true;
    await doc.save();
    await setHumanMode(doc.customerPhone, false); // hand the customer back to the bot
    req.app.get("io")?.to("chat-admins").emit("human-mode-changed", { phone: doc.customerPhone, humanMode: false });
    emitRequest(req.app.get("io"), "agent-request-updated", doc);
    res.json({ success: true, data: toClient(doc) });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.reopen = async (req, res) => {
  try {
    const doc = await loadOwn(req, res); if (!doc) return;
    doc.status = "open";
    doc.resolvedAt = null;
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
    const doc = await HandoffKeyword.findOne({ restaurantId: req.admin.restaurantId }).lean();
    res.json({ success: true, data: doc?.words || [] });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.setKeywords = async (req, res) => {
  try {
    const words = Array.isArray(req.body.words)
      ? [...new Set(req.body.words.map((word) => String(word || "").trim().toLowerCase()).filter((word) => word && word.length <= 60))].slice(0, 100)
      : null;
    if (!words) return res.status(400).json({ success: false, message: "words must be an array" });
    await HandoffKeyword.findOneAndUpdate({ restaurantId: req.admin.restaurantId }, { $set: { words } }, { upsert: true, setDefaultsOnInsert: true });
    res.json({ success: true, data: words });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

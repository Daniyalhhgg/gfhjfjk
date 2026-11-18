const AgentRequest = require("../models/AgentRequest");
const { getSupportSettings, isSupportTypeAvailable, getNextSupportOpening, DEFAULT_RESTAURANT } = require("./supportSettings");
const { sendWhatsAppText } = require("./whatsappText");
const { digitsOnly } = require("../utils/phone");
const { runDueBookingPaymentDeadlines } = require("./bookingPaymentDeadlineService");

let timer = null;
let running = false;

const expirePendingRequests = async (io) => {
  const now = new Date();
  const due = await AgentRequest.find({ status: "open", timeoutAt: { $lte: now } })
    .sort({ timeoutAt: 1 })
    .limit(50)
    .lean();

  for (const request of due) {
    const settings = await getSupportSettings(request.restaurantId || DEFAULT_RESTAURANT);
    if (!settings.requestTimeoutEnabled) {
      await AgentRequest.updateOne(
        { _id: request._id, status: "open" },
        { $set: { timeoutAt: null } }
      );
      continue;
    }
    const claimed = await AgentRequest.findOneAndUpdate(
      { _id: request._id, status: "open", timeoutAt: { $lte: now } },
      { $set: { status: "expired", expiredAt: now, timeoutAt: null, nextEscalationAt: null, seen: true } },
      { new: true }
    );
    if (!claimed) continue;

    io?.to("chat-admins").emit("agent-requests-changed", { phone: claimed.customerPhone });

    try {
      if (settings.timeoutMessage.trim()) {
        await sendWhatsAppText(claimed.customerPhone, settings.timeoutMessage);
        const Chat = require("../models/Chat");
        const chat = await Chat.create({
          restaurantId: claimed.restaurantId,
          customerPhone: digitsOnly(claimed.customerPhone),
          customerName: claimed.customerName || "WhatsApp Customer",
          customerMessage: "",
          botReply: settings.timeoutMessage,
          sender: "bot",
          direction: "bot_to_customer",
          source: "support_timeout",
        });
        io?.to("chat-admins").emit("whatsapp-new-message", {
          phone: digitsOnly(claimed.customerPhone),
          botReply: settings.timeoutMessage,
          isBot: true,
          sender: "bot",
          timestamp: chat.createdAt,
          chatId: chat._id,
        });
      }
    } catch (error) {
      console.error(`Support timeout message failed for request ${claimed._id}:`, error.response?.data?.error?.message || error.message);
    }
  }
};

const processEscalations = async () => {
  const now = new Date();
  const due = await AgentRequest.find({ status: "open", nextEscalationAt: { $lte: now } })
    .sort({ nextEscalationAt: 1 })
    .limit(50)
    .lean();

  for (const request of due) {
    const settings = await getSupportSettings(request.restaurantId || DEFAULT_RESTAURANT);
    if (!isSupportTypeAvailable(settings, "human_request", now)) {
      await AgentRequest.updateOne(
        { _id: request._id, status: "open", nextEscalationAt: { $lte: now } },
        { $set: { nextEscalationAt: getNextSupportOpening(settings, now, "human_request") } }
      );
      continue;
    }
    const levelIndex = Number(request.escalationLevel || 0);
    const level = settings.escalationLevels[levelIndex];
    const following = settings.escalationLevels[levelIndex + 1];
    const claimed = await AgentRequest.findOneAndUpdate(
      {
        _id: request._id,
        status: "open",
        escalationLevel: levelIndex,
        nextEscalationAt: { $lte: now },
      },
      {
        $set: {
          escalationLevel: level ? levelIndex + 1 : levelIndex,
          nextEscalationAt: following
            ? new Date(new Date(request.createdAt).getTime() + following.delayMinutes * 60000)
            : null,
        },
      },
      { new: true }
    );
    if (!claimed || !level) continue;

    try {
      await sendWhatsAppText(
        level.recipientPhone,
        `Support escalation: customer +${digitsOnly(request.customerPhone)} is still waiting for an agent. ${request.lastMessage ? `Message: ${String(request.lastMessage).slice(0, 500)}` : "Please review the Human Agent Requests page."}`
      );
    } catch (error) {
      console.error(`Support escalation to ${level.name} failed for request ${request._id}:`, error.response?.data?.error?.message || error.message);
    }
  }
};

const runDueSupportActions = async (io) => {
  if (running) return;
  running = true;
  try {
    await expirePendingRequests(io);
    await processEscalations();
    await runDueBookingPaymentDeadlines(io);
  } catch (error) {
    console.error("Support automation run failed:", error);
  } finally {
    running = false;
  }
};

const startSupportAutomation = (io) => {
  if (timer) return;
  runDueSupportActions(io);
  timer = setInterval(() => runDueSupportActions(io), 30000);
  timer.unref?.();
};

module.exports = { startSupportAutomation, runDueSupportActions };

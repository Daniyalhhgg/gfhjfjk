const Setting = require("../models/Setting");
const defaultConfig = require("../config/defaultAgentPrompt.json");
const { getBookingPaymentPolicy } = require("../services/bookingPaymentPolicy");
const defaultPrompt = defaultConfig.prompt;
const DEFAULT_VERSION = Number(defaultConfig.version) || 1;
const followUpDelayLabel = (minutes) => {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

const promptWithFollowUpTiming = (content, delayMinutes) => {
  const prompt = String(content || "");
  const timing = followUpDelayLabel(delayMinutes);
  return prompt
    .replace("exactly 24 hours after the timestamp", `after the live CRM-configured delay (${timing}) from the message timestamp`)
    .replace("The schedule is fixed at 24 elapsed hours;", `The live CRM Follow-up Reminders setting controls the delay (${timing});`)
    .replace("saying we will follow up in 24 hours", `stating that we will follow up in ${timing}, in the customer's language`);
};

const MAX_HISTORY = 20;
const MAX_PROMPT_LENGTH = 50000;

const adminName = (admin) => admin?.name || admin?.email || "Admin";

const requireN8nApiKey = (req, res) => {
  const expected = process.env.N8N_API_KEY;
  if (!expected) {
    res.status(503).json({ success: false, message: "AI prompt API is not configured: N8N_API_KEY is required." });
    return false;
  }
  if (req.get("x-api-key") !== expected) {
    res.status(401).json({ success: false, message: "Invalid API key." });
    return false;
  }
  return true;
};

const getOrCreatePromptSettings = async (restaurantId) => {
  const setting = await Setting.findOneAndUpdate(
    { restaurantId },
    {
      $setOnInsert: {
        restaurantId,
        agentPrompt: {
          content: defaultPrompt,
          revision: 1,
          defaultVersion: DEFAULT_VERSION,
          updatedAt: new Date(),
          updatedBy: "System default",
          history: [],
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!setting.agentPrompt?.content?.trim()) {
    setting.agentPrompt = {
      content: defaultPrompt,
      revision: 1,
      defaultVersion: DEFAULT_VERSION,
      updatedAt: new Date(),
      updatedBy: "System default",
      history: setting.agentPrompt?.history || [],
    };
    await setting.save();
  } else if ((setting.agentPrompt.defaultVersion || 0) < DEFAULT_VERSION) {
    // An older prompt is still stored (for example the one from before this release).
    // Replace it once with the current built-in prompt and keep the old text in history so nothing is lost.
    const previous = setting.agentPrompt;
    const history = [...(previous.history || []), {
      revision: previous.revision || 1,
      content: previous.content,
      updatedAt: previous.updatedAt || setting.createdAt || new Date(),
      updatedBy: previous.updatedBy || "System default",
    }].slice(-MAX_HISTORY);
    setting.agentPrompt = {
      content: defaultPrompt,
      revision: (previous.revision || 1) + 1,
      defaultVersion: DEFAULT_VERSION,
      updatedAt: new Date(),
      updatedBy: `System upgrade (prompt v${DEFAULT_VERSION})`,
      history,
    };
    await setting.save();
    console.log(`AI prompt for ${restaurantId} upgraded to built-in version ${DEFAULT_VERSION}; the previous text is in history.`);
  }
  return setting;
};

exports.getAgentPrompt = async (req, res) => {
  try {
    const setting = await getOrCreatePromptSettings(req.admin.restaurantId);
    const promptData = setting.agentPrompt.toObject ? setting.agentPrompt.toObject() : setting.agentPrompt;
    const delayMinutes = Number(setting.followUpReminderDelayMinutes) || 1440;
    res.json({ success: true, data: { ...promptData, content: promptWithFollowUpTiming(setting.agentPrompt.content, delayMinutes) } });
  } catch (error) {
    console.error("getAgentPrompt error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const saveAgentPrompt = async (req, res, content) => {
  try {
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ success: false, message: "Prompt content is required and cannot be empty." });
    }
    if (content.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ success: false, message: `Prompt content must be ${MAX_PROMPT_LENGTH} characters or fewer.` });
    }

    const restaurantId = req.admin.restaurantId;
    const setting = await getOrCreatePromptSettings(restaurantId);
    const now = new Date();
    const history = [...(setting.agentPrompt.history || []), {
      revision: setting.agentPrompt.revision,
      content: setting.agentPrompt.content,
      updatedAt: setting.agentPrompt.updatedAt || setting.createdAt || now,
      updatedBy: setting.agentPrompt.updatedBy || "System default",
    }].slice(-MAX_HISTORY);
    setting.agentPrompt = {
      content: content.trim(),
      revision: setting.agentPrompt.revision + 1,
      defaultVersion: Math.max(setting.agentPrompt.defaultVersion || 0, DEFAULT_VERSION),
      updatedAt: now,
      updatedBy: adminName(req.admin),
      history,
    };
    await setting.save();
    res.json({ success: true, data: setting.agentPrompt });
  } catch (error) {
    console.error("updateAgentPrompt error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateAgentPrompt = async (req, res) => saveAgentPrompt(req, res, req.body?.content);

exports.resetAgentPrompt = async (req, res) => {
  return saveAgentPrompt(req, res, defaultPrompt);
};

exports.getPublicAgentPrompt = async (req, res) => {
  try {
    if (!requireN8nApiKey(req, res)) return;
    const restaurantId = String(req.query.restaurantId || "restaurant-1").trim();
    if (!restaurantId || restaurantId.length > 100) {
      return res.status(400).json({ success: false, message: "A valid restaurantId is required." });
    }
    const [setting, policy] = await Promise.all([
      getOrCreatePromptSettings(restaurantId),
      getBookingPaymentPolicy(restaurantId),
    ]);
    const delayMinutes = Number(setting.followUpReminderDelayMinutes) || 1440;
    const actionText = {
      pending_alert: "If the deadline passes, keep the booking pending and alert CS.",
      auto_cancel: "If the deadline passes without proof under review, the booking is automatically cancelled.",
      no_action: "If the deadline passes, take no automatic action.",
    }[policy.deadlineAction];
    const deadlineText = policy.deadlineMode === "duration"
      ? `${policy.deadlineDurationValue} ${policy.deadlineDurationUnit} after booking or quotation acceptance`
      : `${policy.deadlineMode === "same_day" ? "the same Pakistan-local day" : "the next Pakistan-local day"} at ${policy.deadlineTime} Pakistan time`;
    const disabledCategories = Array.isArray(policy.disabledCategories) ? policy.disabledCategories : [];
    const livePolicy = [
      "LIVE BOOKING PAYMENT POLICY (authoritative; overrides any conflicting advance/deadline percentages or rules elsewhere in this prompt):",
      "Apply this policy to new bookings only. For an existing booking, use its saved advanceAmount, advancePercent, and paymentDeadlineAt from customer CRM context.",
      `For menu categories whose policy checkbox is enabled, required advance is ${policy.advancePercent}%.`,
      policy.advancePercent === 0
        ? "For enabled menu categories, no payment proof or advance is required. Do not request payment. The booking still stays pending until staff confirms it."
        : "For enabled menu categories, tell customers the configured advance percentage and amount from the CRM; do not assume a different percentage.",
      disabledCategories.length
        ? `Policy checkbox is OFF for these categories: ${disabledCategories.join(", ")}. Use the existing legacy 20% advance for them and do not apply the configurable deadline/action.`
        : "Policy checkbox is ON for all current menu categories. New menu categories are enabled by default unless their category is explicitly listed as disabled.",
      `Payment deadline: ${deadlineText}.`,
      `The configured deadline/action applies only to categories with the policy checkbox enabled. ${actionText}`,
      "Wedding and Corporate bookings also retain their existing agreement and staff-confirmation requirements.",
    ].join("\n");
    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      data: {
        prompt: `${promptWithFollowUpTiming(setting.agentPrompt.content, delayMinutes)}\n\n${livePolicy}`,
        revision: setting.agentPrompt.revision,
        bookingPaymentPolicy: policy,
      },
    });
  } catch (error) {
    console.error("getPublicAgentPrompt error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.promptWithFollowUpTiming = promptWithFollowUpTiming;

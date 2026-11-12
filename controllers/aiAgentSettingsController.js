const Setting = require("../models/Setting");

const DEFAULT_AI_AGENTS = [
  { id: "ava", name: "Ava", role: "Query Handling", pages: ["inquiries", "chat", "bookings", "agentrequests", "wedding-bookings", "corporate-bookings"] },
  { id: "remy", name: "Remy", role: "Follow-up", pages: ["Reminderspage", "broadcast"] },
  { id: "nova", name: "Nova", role: "Data Managing", pages: ["dashboard", "customers", "customer-details", "chat"] },
];

const ALLOWED_AGENT_IDS = new Set(DEFAULT_AI_AGENTS.map((agent) => agent.id));
const MAX_AI_AGENTS = 12;
const DEFAULT_AI_TEAM_LABELS = { title: "AI team", subtitle: "Assigned to this page" };
const ALLOWED_PAGES = new Set([
  "dashboard",
  "agentrequests",
  "inquiries",
  "Reminderspage",
  "customers",
  "broadcast",
  "chat",
  "customer-details",
  "bookings",
  "wedding-bookings",
  "corporate-bookings",
]);

exports.getAiAgentSettings = async (req, res) => {
  try {
    const setting = await Setting.findOneAndUpdate(
      { restaurantId: req.admin.restaurantId },
      { $setOnInsert: { restaurantId: req.admin.restaurantId, aiAgents: DEFAULT_AI_AGENTS } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (!setting.aiAgents?.length) {
      setting.aiAgents = DEFAULT_AI_AGENTS;
      await setting.save();
    }

    res.json({
      success: true,
      data: {
        agents: setting.aiAgents,
        teamLabels: setting.aiTeamLabels || DEFAULT_AI_TEAM_LABELS,
      },
    });
  } catch (error) {
    console.error("getAiAgentSettings error:", error);
    res.status(500).json({ success: false, message: "Could not load AI agent settings." });
  }
};

exports.updateAiAgentSettings = async (req, res) => {
  try {
    const submitted = req.body?.agents;
    const submittedLabels = req.body?.teamLabels;
    if (!Array.isArray(submitted) || submitted.length < DEFAULT_AI_AGENTS.length || submitted.length > MAX_AI_AGENTS) {
      return res.status(400).json({ success: false, message: `Include all three built-in agents and no more than ${MAX_AI_AGENTS} agents total.` });
    }
    if (!submittedLabels || typeof submittedLabels !== "object" || Array.isArray(submittedLabels)) {
      return res.status(400).json({ success: false, message: "AI team title and subtitle are required." });
    }
    const teamLabels = {
      title: typeof submittedLabels.title === "string" ? submittedLabels.title.trim() : "",
      subtitle: typeof submittedLabels.subtitle === "string" ? submittedLabels.subtitle.trim() : "",
    };
    if (!teamLabels.title || teamLabels.title.length > 40 || !teamLabels.subtitle || teamLabels.subtitle.length > 80) {
      return res.status(400).json({ success: false, message: "AI team title (1–40 characters) and subtitle (1–80 characters) are required." });
    }

    const seenIds = new Set();
    const seenNames = new Set();
    const agents = [];
    for (const agent of submitted) {
      const validId = typeof agent?.id === "string" &&
        (ALLOWED_AGENT_IDS.has(agent.id) || /^custom-[a-z0-9-]{8,80}$/.test(agent.id));
      if (!agent || typeof agent !== "object" || !validId || seenIds.has(agent.id)) {
        return res.status(400).json({ success: false, message: "The AI agent list contains an invalid or repeated profile." });
      }

      const name = typeof agent.name === "string" ? agent.name.trim() : "";
      const role = typeof agent.role === "string" ? agent.role.trim() : "";
      if (!name || name.length > 40 || !role || role.length > 60) {
        return res.status(400).json({ success: false, message: "Agent names (1–40 characters) and roles (1–60 characters) are required." });
      }
      const normalizedName = name.toLocaleLowerCase();
      if (seenNames.has(normalizedName)) {
        return res.status(400).json({ success: false, message: "Each AI agent must have a different name." });
      }
      if (!Array.isArray(agent.pages) || agent.pages.some((page) => !ALLOWED_PAGES.has(page)) || new Set(agent.pages).size !== agent.pages.length) {
        return res.status(400).json({ success: false, message: "One or more assigned pages are invalid or repeated." });
      }

      seenIds.add(agent.id);
      seenNames.add(normalizedName);
      agents.push({ id: agent.id, name, role, pages: agent.pages });
    }

    if ([...ALLOWED_AGENT_IDS].some((id) => !seenIds.has(id))) {
      return res.status(400).json({ success: false, message: "The three built-in agent profiles must remain in the configuration." });
    }

    const setting = await Setting.findOneAndUpdate(
      { restaurantId: req.admin.restaurantId },
      {
        $set: { aiAgents: agents, aiTeamLabels: teamLabels },
        $setOnInsert: { restaurantId: req.admin.restaurantId },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );

    const io = req.app.get("io");
    if (io) io.to("chat-admins").emit("ai_agent_settings_updated");

    res.json({
      success: true,
      data: {
        agents: setting.aiAgents,
        teamLabels: setting.aiTeamLabels,
      },
    });
  } catch (error) {
    console.error("updateAiAgentSettings error:", error);
    res.status(500).json({ success: false, message: "Could not save AI agent settings." });
  }
};

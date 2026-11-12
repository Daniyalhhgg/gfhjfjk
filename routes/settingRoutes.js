const express = require("express");
const auth = require("../middleware/auth");
const { getLoyaltySettings, updateLoyaltySettings } = require("../controllers/loyaltyController");
const {
  getServiceClosures,
  getPublicServiceClosures,
  upsertServiceClosure,
  deleteServiceClosure,
} = require("../controllers/serviceClosureController");
const {
  getAgentPrompt,
  updateAgentPrompt,
  resetAgentPrompt,
  getPublicAgentPrompt,
} = require("../controllers/agentPromptController");
const { getYesterdayRevenue, saveYesterdayRevenue } = require("../controllers/dailyRevenueController");
const { getAiAgentSettings, updateAiAgentSettings } = require("../controllers/aiAgentSettingsController");

const router = express.Router();
router.get("/agent-prompt/public", getPublicAgentPrompt);
router.get("/service-closures/status", getPublicServiceClosures);
router.get("/agent-prompt", auth, getAgentPrompt);
router.put("/agent-prompt", auth, updateAgentPrompt);
router.post("/agent-prompt/reset", auth, resetAgentPrompt);
router.get("/ai-agents", auth, getAiAgentSettings);
router.put("/ai-agents", auth, updateAiAgentSettings);
router.get("/service-closures", auth, getServiceClosures);
router.post("/service-closures", auth, upsertServiceClosure);
router.delete("/service-closures/:date", auth, deleteServiceClosure);
router.get("/daily-revenue/yesterday", auth, getYesterdayRevenue);
router.put("/daily-revenue/yesterday", auth, saveYesterdayRevenue);
router.get("/loyalty", auth, getLoyaltySettings);
router.put("/loyalty", auth, updateLoyaltySettings);

module.exports = router;

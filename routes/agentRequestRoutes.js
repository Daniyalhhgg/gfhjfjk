const express = require("express");
const auth = require("../middleware/auth");
const controller = require("../controllers/agentRequestController");

const router = express.Router();

// n8n (x-api-key): the bot hands a customer over to a person.
router.post("/from-whatsapp", controller.createFromWhatsApp);

// CRM (admin login).
router.get("/", auth, controller.list);
router.get("/keywords", auth, controller.getKeywords);
router.put("/keywords", auth, controller.setKeywords);
router.delete("/resolved", auth, controller.clearResolved);
router.patch("/:id/take", auth, controller.take);
router.patch("/:id/resolve", auth, controller.resolve);
router.patch("/:id/reopen", auth, controller.reopen);
router.patch("/:id/seen", auth, controller.markSeen);
router.delete("/:id", auth, controller.remove);

module.exports = router;

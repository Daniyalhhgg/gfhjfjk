const mongoose = require("mongoose");

// A customer who needs a real person. Created by the WhatsApp bot (hand-off) or when
// the customer clearly asks for a human. Shown on the CRM "Agent Requests" page.
const messageSchema = new mongoose.Schema({
  from: { type: String, enum: ["customer", "bot", "admin"], default: "customer" },
  text: { type: String, default: "", maxlength: 1000 },
  at: { type: Date, default: Date.now },
}, { _id: false });

const agentRequestSchema = new mongoose.Schema({
  restaurantId: { type: String, required: true, index: true, trim: true },
  customerPhone: { type: String, required: true, trim: true },
  phoneKey: { type: String, required: true, index: true },
  customerName: { type: String, default: "", trim: true },
  reason: { type: String, enum: ["human_requested", "bot_handoff"], default: "human_requested" },
  keyword: { type: String, default: "", trim: true },
  priority: { type: String, enum: ["high", "medium"], default: "high" },
  status: { type: String, enum: ["open", "taken", "resolved"], default: "open", index: true },
  firstMessage: { type: String, default: "", maxlength: 1000 },
  lastMessage: { type: String, default: "", maxlength: 1000 },
  lastAt: { type: Date, default: Date.now },
  count: { type: Number, default: 1 },
  seen: { type: Boolean, default: false },
  messages: { type: [messageSchema], default: [] },
  takenAt: { type: Date, default: null },
  takenBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true });

agentRequestSchema.index({ restaurantId: 1, phoneKey: 1, status: 1 });
agentRequestSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model("AgentRequest", agentRequestSchema);

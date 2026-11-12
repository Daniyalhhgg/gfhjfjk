const mongoose = require("mongoose");

const agentPromptVersionSchema = new mongoose.Schema({
  revision: { type: Number, required: true },
  content: { type: String, required: true, maxlength: 50000 },
  updatedAt: { type: Date, required: true },
  updatedBy: { type: String, default: "System", trim: true, maxlength: 160 },
}, { _id: false });

const aiAgentSchema = new mongoose.Schema({
  id: { type: String, required: true, match: /^(ava|remy|nova|custom-[a-z0-9-]{8,80})$/ },
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 40 },
  role: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
  pages: {
    type: [String],
    default: [],
    enum: [
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
    ],
  },
}, { _id: false });

const aiTeamLabelsSchema = new mongoose.Schema({
  title: { type: String, default: "AI team", trim: true, maxlength: 40 },
  subtitle: { type: String, default: "Assigned to this page", trim: true, maxlength: 80 },
}, { _id: false });

const settingSchema = new mongoose.Schema({
  restaurantId: { type: String, required: true, unique: true, trim: true },
  aiAgents: { type: [aiAgentSchema], default: [] },
  aiTeamLabels: { type: aiTeamLabelsSchema, default: () => ({}) },
  followUpReminderDelayMinutes: { type: Number, default: 1440, min: 1, max: 43200 },
  loyalty: {
    enabled: { type: Boolean, default: true },
    visitsForReward: { type: Number, default: 5, min: 1, max: 100 },
    rewardText: { type: String, default: "Chef Special Dessert", trim: true, maxlength: 160 },
  },
  serviceClosures: [{
    _id: false,
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    updatedAt: { type: Date, default: Date.now },
  }],
  dailyRevenueEntries: [{
    _id: false,
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: "", trim: true, maxlength: 160 },
  }],
  agentPrompt: {
    content: { type: String, default: "", maxlength: 50000 },
    revision: { type: Number, default: 0, min: 0 },
    // Which built-in default prompt this text came from. A newer built-in default replaces an older stored prompt once (the old text is kept in history).
    defaultVersion: { type: Number, default: 0, min: 0 },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: "", trim: true, maxlength: 160 },
    history: { type: [agentPromptVersionSchema], default: [] },
  },
}, { timestamps: true });

module.exports = mongoose.model("Setting", settingSchema);

const mongoose = require("mongoose");

// Extra phrases (added from the CRM) that mean "I want to talk to a person".
const handoffKeywordSchema = new mongoose.Schema({
  restaurantId: { type: String, required: true, unique: true, trim: true },
  words: { type: [String], default: [] },
}, { timestamps: true });

module.exports = mongoose.model("HandoffKeyword", handoffKeywordSchema);

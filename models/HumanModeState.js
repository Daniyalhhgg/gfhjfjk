const mongoose = require("mongoose");

// Human mode must survive server restarts, so it is stored in MongoDB (not in memory).
// While it is on for a customer, the n8n workflow does not let the AI reply to that customer.
const humanModeSchema = new mongoose.Schema({
  phoneKey: { type: String, required: true, unique: true, index: true },
  phone: { type: String, default: "", trim: true },
  on: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model("HumanModeState", humanModeSchema);

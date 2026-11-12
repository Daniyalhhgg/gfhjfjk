const Setting = require("../models/Setting");

const getPakistanDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(date);

const shiftDate = (date, days) => {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
};

exports.getYesterdayRevenue = async (req, res) => {
  try {
    const date = shiftDate(getPakistanDate(), -1);
    const setting = await Setting.findOne({ restaurantId: req.admin.restaurantId })
      .select("dailyRevenueEntries")
      .lean();
    const entry = (setting?.dailyRevenueEntries || []).find((item) => item.date === date) || null;
    res.json({ success: true, data: { date, entry } });
  } catch (error) {
    console.error("getYesterdayRevenue error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.saveYesterdayRevenue = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (req.body.amount === "" || req.body.amount == null || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ success: false, message: "Revenue amount must be a non-negative number." });
    }
    if (req.body.note != null && (typeof req.body.note !== "string" || req.body.note.trim().length > 300)) {
      return res.status(400).json({ success: false, message: "Revenue note must be 300 characters or fewer." });
    }

    const date = shiftDate(getPakistanDate(), -1);
    const setting = await Setting.findOneAndUpdate(
      { restaurantId: req.admin.restaurantId },
      { $setOnInsert: { restaurantId: req.admin.restaurantId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const entry = setting.dailyRevenueEntries.find((item) => item.date === date);
    const updatedAt = new Date();
    const updatedBy = String(req.admin.name || req.admin.email || "Admin").slice(0, 160);
    if (entry) {
      entry.amount = amount;
      entry.note = String(req.body.note || "").trim();
      entry.updatedAt = updatedAt;
      entry.updatedBy = updatedBy;
    } else {
      setting.dailyRevenueEntries.push({
        date,
        amount,
        note: String(req.body.note || "").trim(),
        updatedAt,
        updatedBy,
      });
    }
    await setting.save();
    const savedEntry = setting.dailyRevenueEntries.find((item) => item.date === date);
    res.json({ success: true, data: { date, entry: savedEntry } });
  } catch (error) {
    console.error("saveYesterdayRevenue error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

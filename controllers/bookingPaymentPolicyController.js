const Setting = require("../models/Setting");
const {
  DEFAULT_BOOKING_PAYMENT_POLICY,
  getAvailableBookingCategories,
} = require("../services/bookingPaymentPolicy");

const normalizePolicy = (body = {}) => {
  if (body.advancePercent === undefined || body.advancePercent === null || body.advancePercent === "") {
    return { error: "Advance percentage is required." };
  }
  const advancePercent = Number(body.advancePercent);
  if (!Number.isFinite(advancePercent) || advancePercent < 0 || advancePercent > 100) {
    return { error: "Advance percentage must be between 0 and 100." };
  }

  const deadlineMode = String(body.deadlineMode || "");
  if (!["duration", "same_day", "next_day"].includes(deadlineMode)) {
    return { error: "Choose a valid payment deadline mode." };
  }

  const deadlineDurationValue = Number(body.deadlineDurationValue);
  if (!Number.isInteger(deadlineDurationValue) || deadlineDurationValue < 1 || deadlineDurationValue > 365) {
    return { error: "Deadline duration must be a whole number between 1 and 365." };
  }

  const deadlineDurationUnit = String(body.deadlineDurationUnit || "");
  if (!["hours", "days"].includes(deadlineDurationUnit)) {
    return { error: "Choose hours or days for the duration deadline." };
  }

  const deadlineTime = String(body.deadlineTime || "");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(deadlineTime)) {
    return { error: "Enter the deadline time in 24-hour format." };
  }

  const deadlineAction = String(body.deadlineAction || "");
  if (!["pending_alert", "auto_cancel", "no_action"].includes(deadlineAction)) {
    return { error: "Choose a valid action for bookings past their payment deadline." };
  }

  if (body.disabledCategories !== undefined && (!Array.isArray(body.disabledCategories)
    || body.disabledCategories.some((category) => typeof category !== "string" || !category.trim() || category.trim().length > 120))) {
    return { error: "Menu categories must be a list of valid category names." };
  }
  const disabledCategories = [...new Set((body.disabledCategories || []).map((category) => category.trim()))];
  if (disabledCategories.length > 100) return { error: "You can configure up to 100 menu categories." };

  return {
    value: {
      advancePercent,
      deadlineMode,
      deadlineDurationValue,
      deadlineDurationUnit,
      deadlineTime,
      deadlineAction,
      disabledCategories,
    },
  };
};

const responsePolicy = (policy) => ({
  ...DEFAULT_BOOKING_PAYMENT_POLICY,
  ...(policy || {}),
  updatedAt: policy?.updatedAt || null,
  updatedBy: policy?.updatedBy || "",
});

exports.getBookingPaymentPolicy = async (req, res) => {
  try {
    const [setting, menuCategories] = await Promise.all([
      Setting.findOne({ restaurantId: req.admin.restaurantId }).select("bookingPaymentPolicy").lean(),
      getAvailableBookingCategories(req.admin.restaurantId),
    ]);
    res.json({ success: true, data: { ...responsePolicy(setting?.bookingPaymentPolicy), menuCategories } });
  } catch (error) {
    console.error("Could not load booking payment policy:", error);
    res.status(500).json({ success: false, message: "Could not load booking payment policy." });
  }
};

exports.saveBookingPaymentPolicy = async (req, res) => {
  try {
    const parsed = normalizePolicy(req.body || {});
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const setting = await Setting.findOneAndUpdate(
      { restaurantId: req.admin.restaurantId },
      {
        $set: {
          bookingPaymentPolicy: {
            ...parsed.value,
            updatedAt: new Date(),
            updatedBy: req.admin.name || req.admin.email || "CRM staff",
          },
        },
        $setOnInsert: { restaurantId: req.admin.restaurantId },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).select("bookingPaymentPolicy").lean();
    const menuCategories = await getAvailableBookingCategories(req.admin.restaurantId);
    res.json({ success: true, data: { ...responsePolicy(setting.bookingPaymentPolicy), menuCategories } });
  } catch (error) {
    console.error("Could not save booking payment policy:", error);
    res.status(500).json({ success: false, message: "Could not save booking payment policy." });
  }
};

exports.getPublicBookingPaymentPolicy = async (req, res) => {
  try {
    const expected = process.env.N8N_API_KEY;
    if (!expected) return res.status(503).json({ success: false, message: "Booking payment policy API is not configured." });
    if (req.get("x-api-key") !== expected) return res.status(401).json({ success: false, message: "Invalid API key." });
    const restaurantId = String(req.query.restaurantId || "restaurant-1").trim();
    if (!restaurantId || restaurantId.length > 100) {
      return res.status(400).json({ success: false, message: "A valid restaurantId is required." });
    }
    const setting = await Setting.findOne({ restaurantId }).select("bookingPaymentPolicy").lean();
    const policy = responsePolicy(setting?.bookingPaymentPolicy);
    res.json({
      success: true,
      data: {
        advancePercent: policy.advancePercent,
        deadlineMode: policy.deadlineMode,
        deadlineDurationValue: policy.deadlineDurationValue,
        deadlineDurationUnit: policy.deadlineDurationUnit,
        deadlineTime: policy.deadlineTime,
        deadlineAction: policy.deadlineAction,
        disabledCategories: policy.disabledCategories || [],
      },
    });
  } catch (error) {
    console.error("Could not load booking payment policy for WhatsApp:", error);
    res.status(500).json({ success: false, message: "Could not load booking payment policy." });
  }
};

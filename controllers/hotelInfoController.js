const Setting = require("../models/Setting");

const DEFAULT_RESTAURANT = "restaurant-1";

const normalizeHotelInfo = (body) => {
  const address = String(body.address ?? "").trim();
  const mapUrl = String(body.mapUrl ?? "").trim();
  if (address.length > 1000) return { error: "Address must be 1000 characters or fewer." };
  if (mapUrl.length > 2000) return { error: "Google Maps link must be 2000 characters or fewer." };
  if (mapUrl) {
    try {
      const parsed = new URL(mapUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Unsupported protocol");
    } catch {
      return { error: "Enter a valid Google Maps link beginning with http:// or https://." };
    }
  }
  return { value: { address, mapUrl } };
};

exports.getHotelInfo = async (req, res) => {
  try {
    const setting = await Setting.findOne({ restaurantId: req.admin.restaurantId })
      .select("hotelInfo")
      .lean();
    res.json({
      success: true,
      data: {
        address: setting?.hotelInfo?.address || "",
        mapUrl: setting?.hotelInfo?.mapUrl || "",
        updatedAt: setting?.hotelInfo?.updatedAt || null,
        updatedBy: setting?.hotelInfo?.updatedBy || "",
      },
    });
  } catch (error) {
    console.error("Could not load hotel information:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.saveHotelInfo = async (req, res) => {
  try {
    const parsed = normalizeHotelInfo(req.body || {});
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const setting = await Setting.findOneAndUpdate(
      { restaurantId: req.admin.restaurantId },
      {
        $set: {
          hotelInfo: {
            ...parsed.value,
            updatedAt: new Date(),
            updatedBy: req.admin.name || req.admin.email || "CRM staff",
          },
        },
        $setOnInsert: { restaurantId: req.admin.restaurantId },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).select("hotelInfo").lean();
    res.json({ success: true, data: setting.hotelInfo });
  } catch (error) {
    console.error("Could not save hotel information:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPublicHotelInfo = async (req, res) => {
  try {
    const expected = process.env.N8N_API_KEY;
    if (!expected) return res.status(503).json({ success: false, message: "Hotel information API is not configured." });
    if (req.get("x-api-key") !== expected) return res.status(401).json({ success: false, message: "Invalid API key." });
    const restaurantId = String(req.query.restaurantId || DEFAULT_RESTAURANT).trim();
    if (!restaurantId || restaurantId.length > 100) {
      return res.status(400).json({ success: false, message: "A valid restaurantId is required." });
    }
    const setting = await Setting.findOne({ restaurantId }).select("hotelInfo").lean();
    res.json({
      success: true,
      data: {
        address: setting?.hotelInfo?.address || "",
        mapUrl: setting?.hotelInfo?.mapUrl || "",
      },
    });
  } catch (error) {
    console.error("Could not load hotel information for WhatsApp:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

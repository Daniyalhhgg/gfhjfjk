const DashboardNotification = require("../models/DashboardNotification");
const { isSupportTypeAvailable, getSupportSettings } = require("./supportSettings");

exports.publishDashboardNotification = async (req, data) => {
  const scheduleType = data.type?.startsWith("payment_") || data.type === "payment_received"
    ? "payment_alert"
    : data.type === "human_agent" || data.type === "customer_frustrated"
      ? "human_request"
      : /booking/i.test(data.entityType || "")
        ? "booking_alert"
        : null;
  if (scheduleType) {
    const settings = await getSupportSettings(data.restaurantId);
    if (!isSupportTypeAvailable(settings, scheduleType)) return null;
  }
  const existing = await DashboardNotification.findOne({
    restaurantId: data.restaurantId,
    sourceKey: data.sourceKey,
  });
  if (existing) return existing;

  let notification;
  try {
    notification = await DashboardNotification.create(data);
  } catch (error) {
    if (error.code === 11000) return null;
    throw error;
  }

  const io = req.app.get("io");
  if (io) io.to("chat-admins").emit("dashboard-notification", notification.toObject());
  return notification;
};

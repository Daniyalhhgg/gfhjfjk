const axios = require("axios");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const FormData = require("form-data");
const Chat = require("../models/Chat");
const HumanModeState = require("../models/HumanModeState");
const AgentRequest = require("../models/AgentRequest");
const { phoneKey } = require("../utils/phone");

// ============================================================
// MULTER SETUP
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../uploads/media");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = file.mimetype.includes("audio") ? ".ogg" : path.extname(file.originalname);
    cb(null, unique + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 },
});

exports.uploadMiddleware = upload.single("file");

// ============================================================
// CHECK HUMAN MODE
// ============================================================
exports.checkHumanMode = async (req, res) => {
  const phone = req.params.phone.replace(/[^0-9]/g, "");
  try {
    const state = await HumanModeState.findOne({ phoneKey: phoneKey(phone) }).lean();
    res.json({ success: true, humanMode: Boolean(state?.on), phone });
  } catch (error) {
    // If the lookup fails, let the bot keep answering rather than leaving the customer in silence.
    console.error("checkHumanMode error:", error.message);
    res.json({ success: true, humanMode: false, phone });
  }
};

// ============================================================
// TOGGLE HUMAN MODE
// ============================================================
exports.toggleHumanMode = async (req, res) => {
  const phone = req.params.phone.replace(/[^0-9]/g, "");
  const on = Boolean(req.body.humanMode);
  try {
    await HumanModeState.findOneAndUpdate(
      { phoneKey: phoneKey(phone) },
      { $set: { on, phone } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    // Keep the Agent Requests page in step with the chat page.
    const restaurantId = req.admin.restaurantId;
    if (on) {
      await AgentRequest.updateMany(
        { restaurantId, phoneKey: phoneKey(phone), status: "open" },
        { $set: { status: "taken", takenAt: new Date(), takenBy: req.admin._id, seen: true } }
      );
    } else {
      await AgentRequest.updateMany(
        { restaurantId, phoneKey: phoneKey(phone), status: { $in: ["open", "taken"] } },
        { $set: { status: "resolved", resolvedAt: new Date(), seen: true } }
      );
    }
    console.log(`[Toggle Human Mode] ${phone} → ${on ? "ON" : "OFF"}`);

    const io = req.app.get("io");
    if (io) {
      io.to("chat-admins").emit("human-mode-changed", { phone, humanMode: on });
      io.to("chat-admins").emit("agent-requests-changed", { phone });
    }
    res.json({ success: true, phone, humanMode: on });
  } catch (error) {
    console.error("toggleHumanMode error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================================
// AGENT TEXT REPLY
// ============================================================

// Turns a WhatsApp Cloud API error into a sentence the CRM user can act on.
const whatsappFailure = (error) => {
  const meta = error.response?.data?.error;
  if (meta?.code === 190) return "WhatsApp rejected the access token (expired or wrong). Renew WHATSAPP_ACCESS_TOKEN in the backend settings.";
  if (meta?.code === 131047 || meta?.code === 131026) return "The customer's 24-hour reply window is closed. Send an approved template message instead.";
  if (meta?.code === 100 && /phone number id|object with ID/i.test(meta.message || "")) return "WHATSAPP_PHONE_NUMBER_ID is wrong or does not belong to this token.";
  return meta?.message || error.message || "WhatsApp could not send this message.";
};

exports.sendAgentReply = async (req, res) => {
  try {
    const { toPhone, message } = req.body;
    if (!toPhone || !message) {
      return res.status(400).json({ success: false, message: "toPhone and message required" });
    }

    const phone = toPhone.replace(/[^0-9]/g, "");

    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    await Chat.create({
      restaurantId: req.admin?.restaurantId || "restaurant-1",
      customerPhone: phone,
      botReply: message,
      sender: "admin",
      direction: "admin_to_customer",
      source: "human_agent",
    });

    const io = req.app.get("io");
    if (io) {
      io.to("chat-admins").emit("whatsapp-new-message", {
        phone,
        botReply: message,
        isBot: false,
        sender: "admin",
        timestamp: new Date(),
      });
    }

    res.json({ success: true, message: "Reply sent successfully" });
  } catch (error) {
    console.error("Agent Reply Error:", error.response?.data || error.message);
    // 502: the CRM worked but WhatsApp refused the message, so nothing was delivered.
    res.status(502).json({ success: false, delivered: false, message: whatsappFailure(error) });
  }
};

// ============================================================
// CONVERT AUDIO TO OGG OPUS
// ============================================================
const convertToOggOpus = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const ffmpeg = require("fluent-ffmpeg");
    ffmpeg(inputPath)
      .audioCodec("libopus")
      .audioChannels(1)
      .audioFrequency(16000)
      .format("ogg")
      .on("end", () => resolve())
      .on("error", reject)
      .save(outputPath);
  });
};

// ============================================================
// SEND MEDIA MESSAGE (Fixed)
// ============================================================
exports.sendMediaMessage = async (req, res) => {
  let convertedPath = null;

  try {
    const { toPhone, type, caption } = req.body;

    if (!toPhone || !type || !req.file) {
      return res.status(400).json({ success: false, message: "toPhone, type, and file are required" });
    }

    const phone = toPhone.replace(/[^0-9]/g, "");
    const waType = { image: "image", video: "video", audio: "audio", document: "document" }[type] || "document";

    // ── Step 1: Prepare file buffer ──────────────────────────
    let fileBuffer;
    let uploadFilename;
    let uploadContentType;

    if (type === "audio") {
      convertedPath = req.file.path.replace(/\.[^.]+$/, "_wa.ogg");

      try {
        await convertToOggOpus(req.file.path, convertedPath);
        fileBuffer = fs.readFileSync(convertedPath);
        console.log("[Audio] Converted to ogg/opus successfully");
      } catch (ffErr) {
        console.warn("[Audio] ffmpeg conversion failed, sending raw:", ffErr.message);
        fileBuffer = fs.readFileSync(req.file.path);
      }

      uploadFilename = `voice-${Date.now()}.ogg`;
      uploadContentType = "audio/ogg; codecs=opus";
    } else {
      fileBuffer = fs.readFileSync(req.file.path);
      uploadFilename = req.file.originalname;
      uploadContentType = req.file.mimetype;
    }

    // ── Step 2: Upload media to WhatsApp ─────────────────────
    const uploadForm = new FormData();
    uploadForm.append("file", fileBuffer, {
      filename: uploadFilename,
      contentType: uploadContentType,
    });
    uploadForm.append("messaging_product", "whatsapp");

    const uploadRes = await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`,
      uploadForm,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          ...uploadForm.getHeaders(),
        },
      }
    );

    const mediaId = uploadRes.data.id;
    console.log(`[Media Upload] mediaId: ${mediaId}, type: ${type}`);

    // ── Step 3: Build message payload (FIXED) ────────────────
    const mediaPayload = { id: mediaId };

    if (type === "audio") {
      mediaPayload.voice = true;        // ← Correct key for Cloud API
    }

    if (caption && (waType === "image" || waType === "video" || waType === "document")) {
      mediaPayload.caption = caption;
    }

    if (waType === "document") {
      mediaPayload.filename = req.file.originalname;
    }

    // ── Step 4: Send WhatsApp message ────────────────────────
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: waType,
        [waType]: mediaPayload,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    // ── Step 5: Public URL for dashboard ─────────────────────
    const fileUrl = `${process.env.SERVER_BASE_URL}/uploads/media/${req.file.filename}`;

    // ── Step 6: Save to Database ─────────────────────────────
    await Chat.create({
      restaurantId: req.admin?.restaurantId || "restaurant-1",
      customerPhone: phone,
      botReply: caption || "",
      mediaUrl: fileUrl,
      mediaType: type,
      sender: "admin",
      direction: "admin_to_customer",
      source: "human_agent",
    });

    // ── Step 7: Socket emit ───────────────────────────────────
    const io = req.app.get("io");
    if (io) {
      io.to("chat-admins").emit("whatsapp-new-message", {
        phone,
        botReply: caption || "",
        mediaUrl: fileUrl,
        mediaType: type,
        isBot: false,
        sender: "admin",
        timestamp: new Date(),
      });
    }

    // ── Cleanup ───────────────────────────────────────────────
    fs.unlink(req.file.path, () => {});
    if (convertedPath) fs.unlink(convertedPath, () => {});

    res.json({ success: true, message: "Media sent successfully", mediaUrl: fileUrl });

  } catch (error) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    if (convertedPath) fs.unlink(convertedPath, () => {});

    console.error("Send Media Error:", error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      message: error.response?.data?.error?.message || error.message 
    });
  }
};

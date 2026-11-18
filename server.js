
const path = require('path');
const dotenvPath = path.join(__dirname, '.env');
const dotenvResult = require('dotenv').config({ path: dotenvPath });
if (dotenvResult.error) {
  console.log(`[env] dotenv did not load ${dotenvPath} (${dotenvResult.error.message}). Using process environment only.`);
} else {
  console.log(`[env] dotenv loaded from ${dotenvPath}`);
}

// The WhatsApp token has two common names in .env. Accept either one everywhere in the backend.
if (!process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_TOKEN) process.env.WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
if (!process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_ACCESS_TOKEN) process.env.WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');

const app = express();
const server = http.createServer(app);

// ======================
// SOCKET.IO SETUP
// ======================
const { initSocket } = require('./realtime/socket');
const io = initSocket(server);
app.set('io', io);

// ======================
// MIDDLEWARE
// ======================
app.use(helmet());

// ======================
// CORS CONFIG (PRODUCTION READY)
// ======================
const { isAllowedOrigin } = require('./config/allowedOrigins');

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'] 
}));

// Proper preflight handling
app.options(/.*/, cors());

// ======================
// BODY PARSER
// ======================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ======================
// LOGGER
// ======================
app.use((req, res, next) => {
  console.log(`📡 ${req.method} ${req.originalUrl}`);
  next();
});

// ======================
// DATABASE
// ======================
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('✅ MongoDB Connected');
    try {
      await require('./services/reminderQueue').restorePendingReminders();
    } catch (err) {
      console.error('❌ Pending reminder recovery failed:', err.message);
    }
    try {
      require('./services/supportAutomationService').startSupportAutomation(io);
    } catch (err) {
      console.error('❌ Support automation startup failed:', err.message);
    }
    try {
      await require('./seeds/weddingSeed').seedWeddingData();
      await require('./seeds/buffetMenus').seedBuffetMenus();
      await require('./seeds/roomStaycation').seedRoomStaycationMenu();
    } catch (err) {
      console.error('❌ Menu seed failed:', err.message);
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('❌ Mongo Error:', err.message);
    process.exit(1);
  });

// ======================
// ROOT ROUTE
// ======================
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API RUNNING'
  });
});

// ======================
// TEST ROUTE
// ======================
app.get('/api/test', (req, res) => {
  console.log("🔥 TEST ROUTE HIT");
  res.json({ success: true });
});

// ======================
// MAIN ROUTES
// ======================
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/chats', require('./routes/chatRoutes'));
app.use('/api/bookings', require('./routes/bookingRoutes'));
app.use('/api/customers', require('./routes/customerRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/dashboard/notifications', require('./routes/dashboardNotificationRoutes'));
app.use('/api/webhook', require('./routes/webhookRoutes'));
app.use('/api/reminders', require('./routes/reminderRoutes'));
app.use('/api/agent', require('./routes/agentReply'));
app.use('/api/slots', require('./routes/slotRoutes'));
app.use('/api/rooms', require('./routes/roomRoutes'));
app.use('/api/menus', require('./routes/menuRoutes'));
app.use('/api/inquiry-learning', require('./routes/inquiryLearningRoutes'));
app.use('/api/loyalty', require('./routes/loyaltyRoutes'));
app.use('/api/settings', require('./routes/settingRoutes'));
app.use('/api/weddings', require('./routes/weddingRoutes'));
app.use('/api/corporate', require('./routes/corporateRoutes'));
app.use('/api/agent-requests', require('./routes/agentRequestRoutes'));


// ======================
// HUMAN MODE ROUTES (FINAL FIXED)
// ======================

try {
  const humanModeRoutes = require('./routes/Humanmoderoutes');

  // Clean mounting - no extra wrapper
  app.use('/api/human-mode', humanModeRoutes);

  console.log("🚀 HUMAN MODE ROUTES REGISTERED SUCCESSFULLY");


} catch (err) {
  console.error("❌ humanModeRoutes error:", err.message);
}

// ======================
// HEALTH CHECK
// ======================
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// ======================
// 404 HANDLER
// ======================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.originalUrl}`
  });
});

// ======================
// START SERVER
// ======================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

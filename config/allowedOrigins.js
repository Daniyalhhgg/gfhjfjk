// Frontends allowed to call the API and open the live (socket) connection.
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "https://crm-frontend-fzlmf8woj-daniyal1.vercel.app",
  "https://hotelcrmfrontend.vercel.app",
  "https://hotel-d-gates-ai-frontend.vercel.app",
  "https://crm-frontend-omega-six.vercel.app",
];

// Every new Vercel deployment gets its own preview address (for example hotelcrmfrontend-abc123-daniyal1.vercel.app).
const previewPatterns = [
  /^https:\/\/hotelcrmfrontend[a-z0-9-]*\.vercel\.app$/,
  /^https:\/\/crm-frontend[a-z0-9-]*-daniyal1\.vercel\.app$/,
  /^https:\/\/hotel-d-gates-ai-frontend[a-z0-9-]*\.vercel\.app$/,
];

// Extra origins can be added without a code change: ALLOWED_ORIGINS="https://a.com,https://b.com"
const extraOrigins = String(process.env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);

const isAllowedOrigin = (origin) =>
  !origin || allowedOrigins.includes(origin) || extraOrigins.includes(origin) || previewPatterns.some((pattern) => pattern.test(origin));

module.exports = { allowedOrigins, isAllowedOrigin };

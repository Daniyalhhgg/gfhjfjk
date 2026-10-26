// Detects whether a customer's WhatsApp message clearly asks to talk to a real person.
// Complaints, shouting or repeated messages are intentionally NOT treated as requests.
// Keep this pattern in sync with the "Switch" node in n8n-workflows/restaurant-whatsapp-ai-bot.json.
const HUMAN_REQUEST = /(\bhuman\b|real (person|agent)|live (agent|person)|representative|customer (care|service)|(talk|speak) to (a |an )?(person|agent|someone|manager)|insa+n se|banda?y? se|agent se ba+t|manager se ba+t|kisi se ba+a?t|بات کرنی|انسان|ایجنٹ سے|مینیجر سے|کسٹمر کیئر|بندے سے|کسی سے بات)/i;

const normalise = (text) => String(text || "").toLowerCase().trim().replace(/\s+/g, " ");

exports.detectHumanRequest = (text, customWords = []) => {
  const message = normalise(text);
  if (!message) return null;
  const builtIn = message.match(HUMAN_REQUEST);
  if (builtIn) return { keyword: builtIn[0], priority: "high" };
  const custom = customWords.map(normalise).filter(Boolean).find((word) => message.includes(word));
  return custom ? { keyword: custom, priority: "high" } : null;
};

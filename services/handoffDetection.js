// Detects whether a customer's WhatsApp message clearly asks to talk to a real person.
// Complaints, shouting or repeated messages are intentionally NOT treated as requests.
// The active n8n workflow calls the CRM evaluator so direct-request rules stay centrally configurable.
const HUMAN_REQUEST = /(\bhuman\b|real (person|agent)|live (agent|person)|representative|customer (care|service)|(talk|speak|chat|connect)[^.!?]{0,25}\b(person|agent|someone|manager)\b|(talk|speak) to (a |an )?(person|agent|someone|manager)|\b(call|phone) (me|back)\b|\b(can|could|please|kindly|mujhe|mujhay|ap|aap) [^.?!]{0,35}\b(call|phone)\b[^.?!]{0,30}|\b(call|phone)[^.!?]{0,25}\b(par|per|pe|about|with)\b[^.!?]{0,20}\b(baat|talk|speak)\b|\b(talk|speak)[^.!?]{0,20}\b(on|over|by)\s+(the\s+)?(phone|call)\b|insa+n se|banda?y? se|agent se ba+t|manager se ba+t|kisi se ba+a?t|call (kar|karein|karen|karain|kardo|karwa|milwa)|phone (kar|karein|karen|karain)|baat (call|phone) par|بات کرنی|انسان|ایجنٹ سے|مینیجر سے|کسٹمر کیئر|بندے سے|کسی سے بات|مجھے کال|مجھے فون|کال پر بات|فون پر بات|فون پہ بات)/i;
const DEFAULT_CUSTOM_HANDOFF_KEYWORDS = [
  "booking cancel karni hai",
  "booking cancel karwani hai",
  "booking change karni hai",
  "booking ki date change karni hai",
  "booking confirm nahi hui",
  "meri booking mein masla hai",
  "payment ka masla hai",
  "payment nahi ho rahi",
  "advance pay nahi kar sakta",
  "payment screenshot ka masla hai",
  "refund chahiye",
  "refund lena hai",
  "complaint register karni hai",
  "complaint karni hai",
  "shikayat darj karni hai",
  "staff se shikayat hai",
  "service se khush nahi hoon",
  "room mein masla hai",
  "میری بکنگ منسوخ کریں",
  "بکنگ کی تاریخ تبدیل کرنی ہے",
  "میری بکنگ کنفرم نہیں ہوئی",
  "میری بکنگ میں مسئلہ ہے",
  "ادائیگی کا مسئلہ ہے",
  "ادائیگی نہیں ہو رہی",
  "مجھے ریفنڈ چاہیے",
  "شکایت درج کرنی ہے",
  "کمرے میں مسئلہ ہے",
  "عملے سے شکایت ہے",
  "I want to cancel my booking",
  "I need to change my booking",
  "My booking is not confirmed",
  "I have a problem with my payment",
  "I need a refund",
  "I want to make a complaint",
];
const DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION = 2;
const normalise = (text) => String(text || "").toLowerCase().trim().replace(/\s+/g, " ");

exports.detectHumanRequest = (text, customWords = [], options = {}) => {
  const message = normalise(text);
  if (!message) return null;
  const includeBuiltIn = options.includeBuiltIn !== false;
  const includeCustom = options.includeCustom !== false;
  const builtIn = includeBuiltIn ? message.match(HUMAN_REQUEST) : null;
  if (builtIn) return { keyword: builtIn[0], priority: "high" };
  const custom = includeCustom
    ? customWords.map(normalise).filter(Boolean).find((word) => message.includes(word))
    : null;
  return custom ? { keyword: custom, priority: "high" } : null;
};

exports.DEFAULT_CUSTOM_HANDOFF_KEYWORDS = DEFAULT_CUSTOM_HANDOFF_KEYWORDS;
exports.DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION = DEFAULT_CUSTOM_HANDOFF_KEYWORDS_VERSION;

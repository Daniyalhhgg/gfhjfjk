const test = require("node:test");
const assert = require("node:assert/strict");
const { detectHumanRequest, DEFAULT_CUSTOM_HANDOFF_KEYWORDS } = require("../services/handoffDetection");

test("detects the built-in human request phrases by default", () => {
  assert.equal(detectHumanRequest("Can I speak to a real person?").priority, "high");
});

test("detects customer requests to speak by phone as human-agent requests", () => {
  const examples = [
    "Mujhe call per baat karni hai",
    "Mujhe phone par baat karni hai",
    "Mujhe call kar dein",
    "Please call me",
    "I want to talk over the phone",
    "Could you call me back?",
    "مجھے کال کریں",
    "فون پر بات کرنی ہے",
  ];
  for (const message of examples) {
    assert.equal(detectHumanRequest(message).priority, "high", message);
  }
});

test("matches CRM trigger phrases when configured", () => {
  assert.equal(detectHumanRequest("please cancel my booking", ["cancel my booking"]).keyword, "cancel my booking");
});

test("matches the default hotel support phrases", () => {
  const examples = [
    ["Meri booking cancel karni hai", "booking cancel karni hai"],
    ["Meri booking cancel karwani hai", "booking cancel karwani hai"],
    ["Meri booking change karni hai", "booking change karni hai"],
    ["Booking ki date change karni hai", "booking ki date change karni hai"],
    ["Meri booking confirm nahi hui", "booking confirm nahi hui"],
    ["Meri booking mein masla hai", "meri booking mein masla hai"],
    ["Payment ka masla hai", "payment ka masla hai"],
    ["Payment nahi ho rahi", "payment nahi ho rahi"],
    ["Advance pay nahi kar sakta", "advance pay nahi kar sakta"],
    ["Payment screenshot ka masla hai", "payment screenshot ka masla hai"],
    ["Mujhe refund chahiye", "refund chahiye"],
    ["Mujhe refund lena hai", "refund lena hai"],
    ["Complaint register karni hai", "complaint register karni hai"],
    ["Complaint karni hai", "complaint karni hai"],
    ["Shikayat darj karni hai", "shikayat darj karni hai"],
    ["Staff se shikayat hai", "staff se shikayat hai"],
    ["Service se khush nahi hoon", "service se khush nahi hoon"],
    ["Room mein masla hai", "room mein masla hai"],
    ["میری بکنگ منسوخ کریں", "میری بکنگ منسوخ کریں"],
    ["بکنگ کی تاریخ تبدیل کرنی ہے", "بکنگ کی تاریخ تبدیل کرنی ہے"],
    ["میری بکنگ کنفرم نہیں ہوئی", "میری بکنگ کنفرم نہیں ہوئی"],
    ["میری بکنگ میں مسئلہ ہے", "میری بکنگ میں مسئلہ ہے"],
    ["ادائیگی کا مسئلہ ہے", "ادائیگی کا مسئلہ ہے"],
    ["ادائیگی نہیں ہو رہی", "ادائیگی نہیں ہو رہی"],
    ["مجھے ریفنڈ چاہیے", "مجھے ریفنڈ چاہیے"],
    ["شکایت درج کرنی ہے", "شکایت درج کرنی ہے"],
    ["کمرے میں مسئلہ ہے", "کمرے میں مسئلہ ہے"],
    ["عملے سے شکایت ہے", "عملے سے شکایت ہے"],
    ["I want to cancel my booking", "I want to cancel my booking"],
    ["I need to change my booking", "I need to change my booking"],
    ["My booking is not confirmed", "My booking is not confirmed"],
    ["I have a problem with my payment", "I have a problem with my payment"],
    ["I need a refund", "I need a refund"],
    ["I want to make a complaint", "I want to make a complaint"],
  ];
  assert.equal(DEFAULT_CUSTOM_HANDOFF_KEYWORDS.length, examples.length);
  for (const [message, keyword] of examples) {
    assert.equal(detectHumanRequest(message, DEFAULT_CUSTOM_HANDOFF_KEYWORDS).keyword, keyword.toLowerCase());
  }
});

test("allows built-in and custom request detection to be disabled independently", () => {
  assert.equal(detectHumanRequest("I need a human", ["human"], { includeBuiltIn: false, includeCustom: false }), null);
  assert.equal(detectHumanRequest("cancel my booking", ["cancel my booking"], { includeBuiltIn: false, includeCustom: true }).keyword, "cancel my booking");
  assert.equal(detectHumanRequest("I need a human", [], { includeBuiltIn: true, includeCustom: false }).priority, "high");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const workflow = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "n8n-workflows", "Hotel d'GATES - WhatsApp AI Booking Bot.json"),
  "utf8",
));
const safetyCode = workflow.nodes.find((node) => node.name === "Check AI reply (safety)").parameters.jsCode;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runSafety = new AsyncFunction("$input", "$", safetyCode);
const policyMenu = {
  category: "Hi-Tea Buffet",
  title: "Hi-Tea Buffet",
  childPolicy: { enabled: true, ageLimit: 5, maxFreeChildren: null, requiresGuardian: false },
};

async function checkReply({ output, userMessage, recentChat = [], menu = policyMenu }) {
  const nodes = {
    "Load customer bookings and payments": { data: { recentChat } },
    "Build menu knowledge for AI": { menuContext: JSON.stringify([menu]) },
    "Final customer message": { userMessage },
  };
  const getNode = (name) => ({ first: () => ({ json: nodes[name] || {} }) });
  const result = await runSafety({ first: () => ({ json: { output } }) }, getNode);
  return result[0].json;
}

test("enabled child policy replaces a price quote with the missing child-count question", async () => {
  const result = await checkReply({
    output: "Hi-Tea Buffet, 14 persons. Total Rs 33,586. Confirm karun?",
    userMessage: "Tomorrow mid slot 14 person my name Daniyal",
    recentChat: [{ customerMessage: "Meny booking karwnai ha hi tes ki", botReply: "Zaroor, kis date par?" }],
  });

  assert.equal(result.childPolicyGuarded, true);
  assert.match(result.output, /Aapke 14 guests mein se kitne bachay 5 saal se chhotay hain/);
});

test("the workflow injects a child count answered in the previous chat turn", async () => {
  const action = JSON.stringify({ action: "create_booking", order: { category: "Hi-Tea Buffet", persons: 14 } });
  const result = await checkReply({
    output: action,
    userMessage: "Yes",
    recentChat: [
      { customerMessage: "3", botReply: "The updated total is Rs 30,000. Confirm?" },
      { customerMessage: "Tomorrow, 14 persons", botReply: "Aapke 14 guests mein se kitne bachay 5 saal se chhotay hain?" },
    ],
  });

  assert.deepEqual(JSON.parse(result.output).order.childrenUnderAge, 3);
});

test("guardian-required policies ask a follow-up and preserve a later yes/no answer", async () => {
  const guardianMenu = {
    ...policyMenu,
    childPolicy: { ...policyMenu.childPolicy, requiresGuardian: true },
  };
  const action = JSON.stringify({ action: "create_booking", order: { category: "Hi-Tea Buffet", persons: 14 } });
  const followup = await checkReply({
    output: action,
    userMessage: "3",
    recentChat: [{ customerMessage: "Tomorrow, 14 persons", botReply: "How many children are under 5?" }],
    menu: guardianMenu,
  });
  assert.equal(followup.childPolicyGuarded, true);
  assert.match(followup.output, /parent or guardian/);

  const saved = await checkReply({
    output: action,
    userMessage: "Yes",
    recentChat: [
      { customerMessage: "Yes", botReply: "The total is Rs 30,000. Confirm?" },
      { customerMessage: "3", botReply: "Will these children be accompanied by a parent or guardian?" },
      { customerMessage: "Tomorrow, 14 persons", botReply: "How many children are under 5?" },
    ],
    menu: guardianMenu,
  });
  const savedOrder = JSON.parse(saved.output).order;
  assert.equal(savedOrder.childrenUnderAge, 3);
  assert.equal(savedOrder.guardianAccompanied, true);
});

test("disabled policies preserve booking actions and over-total child counts are clarified", async () => {
  const action = JSON.stringify({ action: "create_booking", order: { category: "Hi-Tea Buffet", persons: 2 } });
  const disabled = await checkReply({
    output: action,
    userMessage: "Book it",
    menu: { ...policyMenu, childPolicy: { ...policyMenu.childPolicy, enabled: false } },
  });
  assert.equal(disabled.output, action);
  assert.equal(disabled.childPolicyGuarded, undefined);

  const excessive = await checkReply({
    output: JSON.stringify({ action: "create_booking", order: { category: "Hi-Tea Buffet", persons: 2 } }),
    userMessage: "3 children under 5",
  });
  assert.equal(excessive.childPolicyGuarded, true);
  assert.match(excessive.output, /cannot exceed the total guests/);
});

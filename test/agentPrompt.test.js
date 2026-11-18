const test = require("node:test");
const assert = require("node:assert/strict");
const { promptWithFollowUpTiming } = require("../controllers/agentPromptController");

test("keeps custom rules added after the automatic reminder section", () => {
  const customRule = "- New hotel-specific support rule added by the admin.";
  const prompt = `AUTOMATIC FOLLOW-UP REMINDERS\nFollow up exactly 24 hours after the timestamp.\n${customRule}`;

  const result = promptWithFollowUpTiming(prompt, 1440);

  assert.ok(result.includes(customRule));
  assert.ok(result.includes("after the live CRM-configured delay (1 day)"));
});

test("replaces only default follow-up timing wording and preserves other prompt text", () => {
  const customRule = "- Preserve this custom instruction.";
  const prompt = `Before reminders.\nThe schedule is fixed at 24 elapsed hours; ${customRule}\nUse the configured schedule, saying we will follow up in 24 hours.`;

  const result = promptWithFollowUpTiming(prompt, 120);

  assert.ok(result.startsWith("Before reminders."));
  assert.ok(result.includes(customRule));
  assert.ok(result.includes("live CRM Follow-up Reminders setting controls the delay (2 hours)"));
  assert.ok(result.includes("stating that we will follow up in 2 hours"));
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildChildPolicySnapshot } = require("../services/childPolicy");

test("disabled child policy leaves the existing booking behavior unchanged", () => {
  const snapshot = buildChildPolicySnapshot({ enabled: false }, { childrenUnderAge: 2 }, 7);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.freeChildren, 0);
  assert.equal(snapshot.childrenUnderAge, 0);
});

test("enabled policy keeps total guests and caps the free-child count", () => {
  const snapshot = buildChildPolicySnapshot(
    { enabled: true, ageLimit: 5, maxFreeChildren: 2, requiresGuardian: false },
    { childrenUnderAge: 3 },
    7,
  );
  assert.equal(snapshot.childrenUnderAge, 3);
  assert.equal(snapshot.freeChildren, 2);
});

test("guardian-required policy only frees children when a guardian is confirmed", () => {
  const policy = { enabled: true, ageLimit: 10, maxFreeChildren: null, requiresGuardian: true };
  const withGuardian = buildChildPolicySnapshot(policy, { childrenUnderAge: 3, guardianAccompanied: true }, 7);
  const withoutGuardian = buildChildPolicySnapshot(policy, { childrenUnderAge: 3, guardianAccompanied: false }, 7);
  assert.equal(withGuardian.freeChildren, 3);
  assert.equal(withoutGuardian.freeChildren, 0);
});

test("guardian-required policy rejects a missing guardian answer", () => {
  assert.throws(
    () => buildChildPolicySnapshot(
      { enabled: true, ageLimit: 10, requiresGuardian: true },
      { childrenUnderAge: 1 },
      2,
    ),
    /Confirm whether the children are accompanied/,
  );
});

test("enabled policy rejects a missing child count instead of assuming zero", () => {
  assert.throws(
    () => buildChildPolicySnapshot({ enabled: true, ageLimit: 5 }, {}, 7),
    /between 0 and the total guest count/,
  );
});

test("enabled policy rejects child counts greater than total guests", () => {
  assert.throws(
    () => buildChildPolicySnapshot({ enabled: true, ageLimit: 5 }, { childrenUnderAge: 8 }, 7),
    /between 0 and the total guest count/,
  );
});

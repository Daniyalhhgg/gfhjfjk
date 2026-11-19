const DEFAULT_CHILD_POLICY = Object.freeze({
  enabled: false,
  ageLimit: 5,
  maxFreeChildren: null,
  requiresGuardian: false,
});

function buildChildPolicySnapshot(policy, bookingData, numberOfPersons) {
  const configured = { ...DEFAULT_CHILD_POLICY, ...(policy || {}) };
  if (!configured.enabled) {
    return {
      enabled: false,
      ageLimit: null,
      maxFreeChildren: null,
      requiresGuardian: false,
      guardianAccompanied: null,
      childrenUnderAge: 0,
      freeChildren: 0,
    };
  }

  if (!Number.isInteger(numberOfPersons) || numberOfPersons < 1) {
    const error = new Error("A valid total guest count is required when the child policy is enabled.");
    error.status = 400;
    throw error;
  }

  const rawChildrenUnderAge = bookingData.childrenUnderAge;
  const childrenUnderAge = Number(rawChildrenUnderAge);
  if (rawChildrenUnderAge === undefined || rawChildrenUnderAge === null || rawChildrenUnderAge === "" ||
    typeof rawChildrenUnderAge === "boolean" || !Number.isInteger(childrenUnderAge) ||
    childrenUnderAge < 0 || childrenUnderAge > numberOfPersons) {
    const error = new Error(`Provide a whole-number count of children under age ${configured.ageLimit}, between 0 and the total guest count.`);
    error.status = 400;
    throw error;
  }

  let guardianAccompanied = null;
  if (configured.requiresGuardian && childrenUnderAge > 0) {
    if (typeof bookingData.guardianAccompanied !== "boolean") {
      const error = new Error("Confirm whether the children are accompanied by a parent or guardian.");
      error.status = 400;
      throw error;
    }
    guardianAccompanied = bookingData.guardianAccompanied;
  }

  const freeChildren = configured.requiresGuardian && !guardianAccompanied
    ? 0
    : Math.min(childrenUnderAge, configured.maxFreeChildren ?? childrenUnderAge);

  return {
    enabled: true,
    ageLimit: configured.ageLimit,
    maxFreeChildren: configured.maxFreeChildren ?? null,
    requiresGuardian: configured.requiresGuardian,
    guardianAccompanied,
    childrenUnderAge,
    freeChildren,
  };
}

module.exports = { DEFAULT_CHILD_POLICY, buildChildPolicySnapshot };

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getSupportAvailability,
  isSupportTypeAvailable,
  getNextSupportOpening,
} = require("../services/supportSettings");

const scheduled = {
  supportAvailabilityMode: "scheduled",
  supportDays: [1, 2, 3, 4, 5, 6, 0],
  supportStartTime: "10:00",
  supportEndTime: "17:00",
};

test("scheduled support opens at 10:00 and closes at 17:00 Pakistan time", () => {
  assert.equal(getSupportAvailability(scheduled, new Date("2024-01-01T04:59:00Z")).available, false);
  assert.equal(getSupportAvailability(scheduled, new Date("2024-01-01T05:00:00Z")).available, true);
  assert.equal(getSupportAvailability(scheduled, new Date("2024-01-01T11:59:00Z")).available, true);
  assert.equal(getSupportAvailability(scheduled, new Date("2024-01-01T12:00:00Z")).available, false);
});

test("scheduled support respects selected weekdays", () => {
  const weekdaysOnly = { ...scheduled, supportDays: [1, 2, 3, 4, 5] };
  assert.equal(getSupportAvailability(weekdaysOnly, new Date("2024-01-06T06:00:00Z")).available, false);
  assert.equal(getSupportAvailability(weekdaysOnly, new Date("2024-01-01T06:00:00Z")).available, true);
});

test("always and unavailable modes override the schedule", () => {
  assert.equal(getSupportAvailability({ ...scheduled, supportAvailabilityMode: "always" }, new Date("2024-01-01T00:00:00Z")).available, true);
  assert.equal(getSupportAvailability({ ...scheduled, supportAvailabilityMode: "unavailable" }, new Date("2024-01-01T06:00:00Z")).available, false);
});

test("after-hours escalation is deferred until the next selected support opening", () => {
  const sundayEvening = new Date("2024-01-07T12:30:00Z");
  assert.equal(getNextSupportOpening(scheduled, sundayEvening).toISOString(), "2024-01-08T05:00:00.000Z");
  assert.equal(getNextSupportOpening({ ...scheduled, supportDays: [1] }, new Date("2024-01-01T03:00:00Z")).toISOString(), "2024-01-01T05:00:00.000Z");
  assert.equal(getNextSupportOpening({ ...scheduled, supportAvailabilityMode: "unavailable" }, sundayEvening), null);
});

test("each weekday can have independent hours, all-day availability, or be closed", () => {
  const weekly = Array.from({ length: 7 }, (_, day) => ({ day, mode: "closed" }));
  weekly[1] = { day: 1, mode: "custom", startTime: "08:00", endTime: "12:00" };
  weekly[2] = { day: 2, mode: "all_day" };
  const settings = { supportAvailabilityMode: "scheduled", supportWeeklySchedule: weekly };

  assert.equal(getSupportAvailability(settings, new Date("2024-01-01T02:59:00Z")).available, false);
  assert.equal(getSupportAvailability(settings, new Date("2024-01-01T03:00:00Z")).available, true);
  assert.equal(getSupportAvailability(settings, new Date("2024-01-01T07:00:00Z")).available, false);
  assert.equal(getSupportAvailability(settings, new Date("2024-01-02T18:00:00Z")).available, true);
  assert.equal(getSupportAvailability(settings, new Date("2024-01-03T06:00:00Z")).available, false);
});

test("the human-support schedule does not suppress internal booking or payment alerts", () => {
  const weekdaysOnly = {
    ...scheduled,
    supportScheduleTypes: ["booking_alert", "payment_alert"],
  };
  const outsideHours = new Date("2024-01-01T03:00:00Z");
  assert.equal(isSupportTypeAvailable(weekdaysOnly, "human_request", outsideHours), false);
  assert.equal(isSupportTypeAvailable(weekdaysOnly, "booking_alert", outsideHours), true);
  assert.equal(isSupportTypeAvailable(weekdaysOnly, "payment_alert", outsideHours), true);
  assert.equal(isSupportTypeAvailable(weekdaysOnly, "booking_issue", outsideHours), true);
  assert.equal(isSupportTypeAvailable({ ...weekdaysOnly, supportAvailabilityMode: "unavailable" }, "human_request", outsideHours), false);
  assert.equal(isSupportTypeAvailable({ ...weekdaysOnly, supportAvailabilityMode: "unavailable" }, "payment_alert", outsideHours), true);
  assert.equal(isSupportTypeAvailable({ ...weekdaysOnly, supportAvailabilityMode: "unavailable" }, "booking_alert", outsideHours), true);
});

test("next opening uses the next day's independent schedule", () => {
  const weekly = Array.from({ length: 7 }, (_, day) => ({ day, mode: "closed" }));
  weekly[1] = { day: 1, mode: "custom", startTime: "10:00", endTime: "17:00" };
  weekly[2] = { day: 2, mode: "custom", startTime: "08:30", endTime: "12:00" };
  const settings = { supportAvailabilityMode: "scheduled", supportWeeklySchedule: weekly };
  assert.equal(
    getNextSupportOpening(settings, new Date("2024-01-01T12:00:00Z")).toISOString(),
    "2024-01-02T03:30:00.000Z",
  );
});

test("human-support availability follows its weekly schedule independently", () => {
  const humanHours = Array.from({ length: 7 }, (_, day) => ({ day, mode: "closed" }));
  humanHours[1] = { day: 1, mode: "custom", startTime: "10:00", endTime: "17:00" };
  const settings = {
    supportAvailabilityMode: "scheduled",
    supportWeeklySchedule: humanHours,
  };
  const mondayAt11Pakistan = new Date("2024-01-01T06:00:00Z");

  assert.equal(isSupportTypeAvailable(settings, "human_request", mondayAt11Pakistan), true);
  assert.equal(isSupportTypeAvailable(settings, "booking_alert", mondayAt11Pakistan), true);
  assert.equal(isSupportTypeAvailable(settings, "payment_alert", mondayAt11Pakistan), true);
  assert.equal(isSupportTypeAvailable(settings, "booking_issue", mondayAt11Pakistan), true);
  assert.equal(getNextSupportOpening(settings, mondayAt11Pakistan, "human_request").toISOString(), mondayAt11Pakistan.toISOString());
});

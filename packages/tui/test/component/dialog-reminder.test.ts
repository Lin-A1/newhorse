import { describe, expect, test } from "bun:test"
import { normalizeReminderRule, parseReminderSchedule, reminderDetails } from "../../src/component/dialog-reminder-state"
import type { ReminderInfo } from "../../src/component/dialog-reminder-state"

const reminder: ReminderInfo = {
  id: "sch_one",
  profileID: "assistant",
  type: "reminder",
  title: "Review",
  body: "Review the day",
  scheduleAt: Date.UTC(2030, 0, 1, 12),
  timezone: "UTC",
  recurrenceRule: "FREQ=DAILY;INTERVAL=2",
  misfirePolicy: "catch_up_once",
  status: "pending",
  attemptCount: 0,
  timeCreated: 1,
  timeUpdated: 1,
}

describe("Reminder dialog state", () => {
  test("normalizes the supported recurrence subset", () => {
    expect(normalizeReminderRule("")).toBeUndefined()
    expect(normalizeReminderRule("freq=daily")).toBe("FREQ=DAILY;INTERVAL=1")
    expect(normalizeReminderRule("FREQ=WEEKLY;INTERVAL=2")).toBe("FREQ=WEEKLY;INTERVAL=2")
    expect(() => normalizeReminderRule("FREQ=MONTHLY")).toThrow()
    expect(() => normalizeReminderRule("FREQ=DAILY;INTERVAL=366")).toThrow()
  })

  test("parses schedules and renders provenance details", () => {
    expect(parseReminderSchedule("2030-01-01T12:00:00.000Z")).toBe(Date.UTC(2030, 0, 1, 12))
    expect(() => parseReminderSchedule("not-a-date")).toThrow()
    expect(reminderDetails(reminder)).toEqual([
      "reminder · profile assistant",
      "2030-01-01T12:00:00.000Z · UTC",
      "FREQ=DAILY;INTERVAL=2",
    ])
  })
})

import { describe, expect, test } from "bun:test"
import type { NormalizedReminderInfo } from "./settings-reminders-helpers"
import {
  formatNominalTime,
  markReminderCancelled,
  parseRecurrenceRule,
  parseSchedule,
  reconcileReminder,
  recurrenceRule,
  recurrenceSummary,
  scheduleInput,
} from "./settings-reminders-helpers"

function reminder(
  id: string,
  scheduleAt: number,
  overrides: Partial<NormalizedReminderInfo> = {},
): NormalizedReminderInfo {
  return {
    id,
    profileID: "profile-1",
    type: "reminder",
    title: `Reminder ${id}`,
    body: "Body",
    scheduleAt,
    timezone: "UTC",
    misfirePolicy: "skip",
    status: "pending",
    attemptCount: 0,
    timeCreated: scheduleAt,
    timeUpdated: scheduleAt,
    ...overrides,
  }
}

describe("Reminder recurrence helpers", () => {
  test("builds one-shot, daily, and weekly recurrence rules", () => {
    expect(recurrenceRule("once", 1)).toBeUndefined()
    expect(recurrenceRule("daily", 2)).toBe("FREQ=DAILY;INTERVAL=2")
    expect(recurrenceRule("weekly", 3)).toBe("FREQ=WEEKLY;INTERVAL=3")
    expect(recurrenceRule("daily", 0)).toBe("FREQ=DAILY;INTERVAL=1")
  })

  test("parses recurrence rules and produces readable summaries", () => {
    expect(parseRecurrenceRule()).toEqual({ recurrence: "once", interval: 1 })
    expect(parseRecurrenceRule("FREQ=DAILY;INTERVAL=4")).toEqual({ recurrence: "daily", interval: 4 })
    expect(parseRecurrenceRule("INTERVAL=2;FREQ=WEEKLY")).toEqual({ recurrence: "weekly", interval: 2 })
    expect(recurrenceSummary()).toBe("One-shot")
    expect(recurrenceSummary("FREQ=DAILY;INTERVAL=1")).toBe("Every day")
    expect(recurrenceSummary("FREQ=WEEKLY;INTERVAL=3")).toBe("Every 3 weeks")
  })
})

describe("Reminder schedule helpers", () => {
  test("converts a local schedule using its timezone", () => {
    const value = parseSchedule("2030-01-02T03:04", "America/New_York")
    expect(new Date(value).toISOString()).toBe("2030-01-02T08:04:00.000Z")
    expect(scheduleInput(value, "America/New_York")).toBe("2030-01-02T03:04")
    expect(formatNominalTime(value, "UTC")).toContain("2030-01-02 08:04")
  })

  test("rejects missing and invalid schedules", () => {
    expect(() => parseSchedule("", "UTC")).toThrow("Schedule must include a date and time")
    expect(() => parseSchedule("not-a-date", "UTC")).toThrow()
    expect(() => parseSchedule("2030-01-02T03:04", "Not/A_Timezone")).toThrow()
  })
})

describe("Reminder reconciliation", () => {
  test("inserts and replaces reminders in nominal-time order", () => {
    const later = reminder("later", 20)
    const earlier = reminder("earlier", 10)
    expect(reconcileReminder([later], earlier).map((item) => item.id)).toEqual(["earlier", "later"])

    const updated = reminder("later", 5, { title: "Updated" })
    const result = reconcileReminder([earlier, later], updated)
    expect(result.map((item) => item.id)).toEqual(["later", "earlier"])
    expect(result[0]?.title).toBe("Updated")
  })

  test("marks only the selected reminder cancelled", () => {
    const items = [reminder("first", 10), reminder("second", 20)]
    const result = markReminderCancelled(items, "second", 30)
    expect(result[0]?.status).toBe("pending")
    expect(result[1]?.status).toBe("cancelled")
    expect(result[1]?.timeUpdated).toBe(30)
  })
})

import { describe, expect, test } from "bun:test"
import { nextOccurrence, normalizeRule, occurrencesAfter, parseRule } from "@/scheduler/recurrence"

const hour = 60 * 60 * 1000
const day = 24 * hour

describe("Scheduler recurrence", () => {
  test("normalizes the supported daily and weekly subset", () => {
    expect(normalizeRule("freq=daily")).toBe("FREQ=DAILY;INTERVAL=1")
    expect(normalizeRule("FREQ=WEEKLY;INTERVAL=2")).toBe("FREQ=WEEKLY;INTERVAL=2")
    expect(parseRule("FREQ=MONTHLY")).toBeUndefined()
    expect(parseRule("FREQ=DAILY;INTERVAL=0")).toBeUndefined()
    expect(parseRule("FREQ=DAILY;INTERVAL=366")).toBeUndefined()
  })

  test("keeps the local wall-clock time across daylight-saving changes", () => {
    const beforeSpring = Date.UTC(2026, 2, 7, 14)
    expect(nextOccurrence({ occurrenceAt: beforeSpring, recurrenceRule: "FREQ=DAILY", timezone: "America/New_York" })).toBe(
      Date.UTC(2026, 2, 8, 13),
    )

    const beforeFall = Date.UTC(2026, 9, 31, 13)
    expect(nextOccurrence({ occurrenceAt: beforeFall, recurrenceRule: "FREQ=DAILY", timezone: "America/New_York" })).toBe(
      Date.UTC(2026, 10, 1, 14),
    )
  })

  test("rolls nonexistent local times forward and chooses the earlier repeated offset", () => {
    const spring = Date.UTC(2026, 2, 7, 7, 30)
    expect(nextOccurrence({ occurrenceAt: spring, recurrenceRule: "FREQ=DAILY", timezone: "America/New_York" })).toBe(
      Date.UTC(2026, 2, 8, 7, 30),
    )

    const fall = Date.UTC(2026, 9, 31, 5, 30)
    expect(nextOccurrence({ occurrenceAt: fall, recurrenceRule: "FREQ=DAILY", timezone: "America/New_York" })).toBe(
      Date.UTC(2026, 10, 1, 5, 30),
    )
    expect(nextOccurrence({ occurrenceAt: fall, recurrenceRule: "FREQ=DAILY", timezone: "Not/A_Zone" })).toBeUndefined()
  })

  test("catches up only the latest missed occurrence", () => {
    expect(
      occurrencesAfter({
        scheduleAt: 10 * day,
        recurrenceRule: "FREQ=DAILY",
        timezone: "UTC",
        now: 13 * day + hour,
        misfirePolicy: "catch_up_once",
      }),
    ).toEqual({ occurrenceAt: 13 * day, nextScheduleAt: 14 * day })
  })

  test("skips missed occurrences without staging a notification", () => {
    expect(
      occurrencesAfter({
        scheduleAt: 10 * day,
        recurrenceRule: "FREQ=DAILY",
        timezone: "UTC",
        now: 13 * day + hour,
        misfirePolicy: "skip",
      }),
    ).toEqual({ occurrenceAt: undefined, nextScheduleAt: 14 * day })
  })

  test("jumps across long downtime without enumerating every occurrence", () => {
    expect(
      occurrencesAfter({
        scheduleAt: 0,
        recurrenceRule: "FREQ=WEEKLY;INTERVAL=2",
        timezone: "UTC",
        now: 50 * 365 * day,
        misfirePolicy: "catch_up_once",
      }),
    ).toEqual({ occurrenceAt: 18_242 * day, nextScheduleAt: 18_256 * day })
  })
})

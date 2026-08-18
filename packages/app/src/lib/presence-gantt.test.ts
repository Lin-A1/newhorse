import { describe, expect, test } from "bun:test"
import { DAY_MS, MAX_GANTT_ROWS, dayStartMs, formatDuration, groupSegments } from "./presence-gantt"

const HOUR = 60 * 60 * 1000

describe("groupSegments", () => {
  const now = () => dayStartMs() + 12 * HOUR

  test("groups segments by app into one row per app", () => {
    const rows = groupSegments(
      [
        { app: "chrome", start: now() - 3 * HOUR, end: now() - 2 * HOUR },
        { app: "vscode", start: now() - 2 * HOUR, end: now() - HOUR },
        { app: "chrome", start: now() - HOUR, end: now() },
      ],
      now(),
    )
    expect(rows).toHaveLength(2)
    const chrome = rows.find((row) => row.app === "chrome")
    const vscode = rows.find((row) => row.app === "vscode")
    expect(chrome?.segments).toHaveLength(2)
    expect(chrome?.totalMs).toBe(2 * HOUR)
    expect(vscode?.totalMs).toBe(HOUR)
  })

  test("sorts rows by total duration descending", () => {
    const rows = groupSegments(
      [
        { app: "a", start: now() - HOUR, end: now() },
        { app: "b", start: now() - 5 * HOUR, end: now() - 2 * HOUR },
      ],
      now(),
    )
    expect(rows[0]?.app).toBe("b")
    expect(rows[1]?.app).toBe("a")
  })

  test("treats an open segment (no end) as running to now", () => {
    const rows = groupSegments([{ app: "figma", start: now() - HOUR }], now())
    expect(rows[0]?.segments[0]?.end).toBe(now())
    expect(rows[0]?.totalMs).toBe(HOUR)
  })

  test("clamps segments that start before midnight to the day window", () => {
    const rows = groupSegments([{ app: "yesterday", start: dayStartMs() - 2 * HOUR, end: dayStartMs() + HOUR }], now())
    expect(rows[0]?.segments[0]?.start).toBe(dayStartMs())
    expect(rows[0]?.totalMs).toBe(HOUR)
  })

  test("drops segments entirely before today", () => {
    const rows = groupSegments([{ app: "stale", start: dayStartMs() - 5 * HOUR, end: dayStartMs() - 4 * HOUR }], now())
    expect(rows).toHaveLength(0)
  })

  test("caps rows to the top apps by duration", () => {
    const segments = Array.from({ length: 12 }, (_, index) => ({
      app: `app${index}`,
      start: dayStartMs() + index * HOUR,
      end: dayStartMs() + (index + 1) * HOUR,
    }))
    const rows = groupSegments(segments, now())
    expect(rows.length).toBeLessThanOrEqual(MAX_GANTT_ROWS)
    expect(rows.length).toBe(MAX_GANTT_ROWS)
  })
})

describe("formatDuration", () => {
  test("formats minutes only", () => {
    expect(formatDuration(45 * 60_000)).toBe("45m")
  })
  test("formats hours and minutes", () => {
    expect(formatDuration(2 * HOUR + 5 * 60_000)).toBe("2h5m")
  })
  test("floors sub-minute durations to 1 minute", () => {
    expect(formatDuration(20_000)).toBe("1m")
  })
  test("rounds half hours", () => {
    expect(formatDuration(HOUR + 30 * 60_000)).toBe("1h30m")
  })
})

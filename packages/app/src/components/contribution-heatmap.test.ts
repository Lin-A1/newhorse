import { describe, expect, test } from "bun:test"
import { buildContributionWeeks, sessionActivityTimestamp, sessionTokenTotal } from "./contribution-heatmap"

describe("buildContributionWeeks", () => {
  test("aligns asynchronously loaded days into complete weeks", () => {
    const cells = Array.from({ length: 10 }, (_, index) => ({
      key: `day-${index}`,
      label: `${index}`,
      tokens: index,
      level: 0 as const,
    }))

    const weeks = buildContributionWeeks(cells, 2)

    expect(weeks).toHaveLength(2)
    expect(weeks[0]?.slice(0, 2)).toEqual([null, null])
    expect(weeks.flat().filter(Boolean)).toEqual(cells)
    expect(weeks.every((week) => week.length === 7)).toBe(true)
  })
})

describe("heatmap session attribution", () => {
  test("uses the last activity date and sums produced tokens only", () => {
    expect(sessionActivityTimestamp({ time: { created: 1, updated: 2 } })).toBe(2)
    // Cache reads are excluded: they are passive reuse, not activity.
    expect(sessionTokenTotal({ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } })).toBe(6)
  })
})

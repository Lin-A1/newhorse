import { describe, expect, test } from "bun:test"
import { create } from "@newhorse/schema/identifier"

// The 48-bit (6-byte) time field of legacy IDs wrapped on 2026-08-14T11:19:55Z,
// i.e. at 26 * 2^36 ms since the epoch. Current IDs use a 7-byte field plus a "z"
// era marker on ascending IDs so they string-sort after every legacy ID.
const WRAP = 2 ** 36
const NOW = Date.now()

describe("identifier", () => {
  test("ascending IDs are lexicographically monotonic in time at current scale", () => {
    const a = create(false, NOW - 1000)
    const b = create(false, NOW)
    const c = create(false, NOW + 1000)

    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })

  test("ascending IDs do not wrap across the legacy 48-bit rollover", () => {
    const before = create(false, WRAP - 1000)
    const after = create(false, WRAP + 1000)

    // With the legacy 6-byte field, `after` would have wrapped to a small value
    // and sorted before `before`. The 7-byte field keeps it monotonic.
    expect(after > before).toBe(true)
  })

  test("new ascending IDs string-sort after every legacy ID", () => {
    // Legacy ascending IDs begin with a hex digit (0–f); current IDs begin with
    // "z", the largest base62 char.
    const legacy = "f".repeat(12) + "0".repeat(14)
    const current = create(false, NOW)

    expect(current > legacy).toBe(true)
  })

  test("descending IDs reverse lexicographic order with time", () => {
    const a = create(true, NOW - 1000)
    const b = create(true, NOW)

    expect(a > b).toBe(true)
  })
})

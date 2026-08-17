import { describe, expect, test } from "bun:test"
import type { ServerSDK } from "@/context/server-sdk"
import {
  aggregate,
  listAllSessions,
  type MessageUsage,
  rangeStart,
  type SessionUsageWithMessages,
} from "./settings-usage"

// ---------------------------------------------------------------------------
// Unit tests for the usage tab's data plumbing.
//
// listAllSessions drives the client-side pagination of session.list: it must
// follow x-next-cursor across every page (otherwise usage beyond the first
// ~1000 sessions is silently dropped from the stats) and must always request
// archived sessions (archived is not deleted, so skipping them would drop whole
// sessions from the totals). aggregate() reduces the fetched rows into the
// stat/trend buckets the tab renders.
// ---------------------------------------------------------------------------

type Session = {
  id?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  model?: { id: string; providerID: string }
  time?: { created: number }
}

type Page = { items: Session[]; next?: number }

function makeServerSDK(pages: Page[]) {
  const calls: Array<{ limit: number; archived: boolean; cursor?: number }> = []
  let call = 0
  const sdk = {
    client: {
      experimental: {
        session: {
          list: async (query: { limit: number; archived: boolean; cursor?: number }) => {
            calls.push(query)
            const page = pages[Math.min(call, pages.length - 1)]
            call++
            return {
              data: page.items,
              response:
                page.next === undefined
                  ? undefined
                  : { headers: { get: (name: string) => (name === "x-next-cursor" ? String(page.next) : null) } },
            }
          },
        },
      },
    },
  } as unknown as ServerSDK
  return { serverSDK: () => sdk, calls }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date("2030-01-10T12:00:00Z").getTime()

function session(overrides: Partial<Session> & { messages?: MessageUsage[] } = {}): SessionUsageWithMessages {
  const id = overrides.id ?? `s-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    messages: [],
    cost: 1,
    tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 40, write: 5 } },
    model: { id: "test-model", providerID: "test" },
    time: { created: NOW },
    ...overrides,
  }
}

function message(overrides: Partial<MessageUsage>): MessageUsage {
  return {
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: "test",
    modelID: "test-model",
    time: NOW,
    ...overrides,
  }
}

describe("listAllSessions", () => {
  test("follows the x-next-cursor across pages until exhausted", async () => {
    const { serverSDK, calls } = makeServerSDK([
      { items: [session({ cost: 1 })], next: 123 },
      { items: [session({ cost: 2 })], next: 456 },
      { items: [session({ cost: 3 })] },
    ])

    const sessions = await listAllSessions(serverSDK)

    expect(sessions).toEqual([
      expect.objectContaining({ cost: 1 }),
      expect.objectContaining({ cost: 2 }),
      expect.objectContaining({ cost: 3 }),
    ])
    // Three pages, each requesting archived sessions, cursor threaded between.
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.archived === true)).toBe(true)
    expect(calls[0]!.cursor).toBeUndefined()
    expect(calls[1]!.cursor).toBe(123)
    expect(calls[2]!.cursor).toBe(456)
  })

  test("stops paging when the server returns no next cursor", async () => {
    const { serverSDK, calls } = makeServerSDK([
      { items: [session()], next: 1 },
      { items: [session()] },
    ])

    const sessions = await listAllSessions(serverSDK)

    expect(sessions).toHaveLength(2)
    expect(calls).toHaveLength(2)
  })

  test("stops paging at the page cap instead of looping forever", async () => {
    // Every page points at a next page; the cap must bound the total.
    const pages = Array.from({ length: 120 }, (_, i) => ({ items: [session({ cost: i })], next: i + 1 }))
    const { serverSDK, calls } = makeServerSDK(pages)

    const sessions = await listAllSessions(serverSDK)

    expect(calls).toHaveLength(100)
    expect(sessions).toHaveLength(100)
  })

  test("tolerates an empty data field", async () => {
    const { serverSDK, calls } = makeServerSDK([{ items: [] }])
    expect(await listAllSessions(serverSDK)).toEqual([])
    expect(calls).toHaveLength(1)
  })
})

describe("rangeStart", () => {
  test("bounds each range against the start of today", () => {
    const startOfToday = new Date(NOW)
    startOfToday.setHours(0, 0, 0, 0)
    expect(rangeStart("today", NOW)).toBe(startOfToday.getTime())
    expect(rangeStart("7d", NOW)).toBe(startOfToday.getTime() - 6 * DAY)
    expect(rangeStart("30d", NOW)).toBe(startOfToday.getTime() - 29 * DAY)
    expect(rangeStart("all", NOW)).toBeUndefined()
  })
})

describe("aggregate", () => {
  test("counts archived sessions and sums tokens across the range", () => {
    const totals = aggregate(
      [
        session({ cost: 1.5, time: { created: NOW } }),
        session({ cost: 0.5, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: NOW - 3 * DAY } }),
        session({ cost: 2, time: { created: NOW - 40 * DAY } }),
      ],
      "7d",
      NOW,
    )

    // The 40-day-old session falls outside the 7d window.
    expect(totals.sessions).toBe(2)
    expect(totals.cost).toBe(2)
    expect(totals.input).toBe(120)
    expect(totals.output).toBe(60)
    expect(totals.cacheRead).toBe(40)
    expect(totals.byModel).toHaveLength(1)
    expect(totals.byModel[0]).toMatchObject({ name: "test-model", sessions: 2, cost: 2, tokens: 190 })
    expect(totals.byProvider[0]).toMatchObject({ name: "test", sessions: 2 })
    expect(totals.trend).toHaveLength(7)
  })

  test("only today's sessions count for the today range", () => {
    const totals = aggregate(
      [
        session({ time: { created: NOW } }),
        session({ time: { created: NOW - 3 * DAY } }),
        session({ time: { created: NOW - 40 * DAY } }),
      ],
      "today",
      NOW,
    )
    expect(totals.sessions).toBe(1)
    expect(totals.trend).toHaveLength(1)
  })

  test("the all range includes every session", () => {
    const totals = aggregate(
      [
        session({ time: { created: NOW } }),
        session({ time: { created: NOW - 3 * DAY } }),
        session({ time: { created: NOW - 40 * DAY } }),
      ],
      "all",
      NOW,
    )
    expect(totals.sessions).toBe(3)
    expect(totals.cost).toBe(3)
  })

  test("handles rows without tokens or model gracefully", () => {
    const totals = aggregate(
      [
        {
          id: "empty",
          messages: [],
          cost: 0.75,
          time: { created: NOW },
        },
      ],
      "7d",
      NOW,
    )
    expect(totals.sessions).toBe(1)
    expect(totals.cost).toBe(0.75)
    expect(totals.input).toBe(0)
    expect(totals.byModel[0]).toMatchObject({ name: "unknown", sessions: 1 })
  })

  test("splits a session that switched models across both models", () => {
    const totals = aggregate(
      [
        session({
          id: "switcher",
          model: { id: "haiku", providerID: "anthropic" },
          time: { created: NOW },
          messages: [
            message({ modelID: "opus", providerID: "anthropic", cost: 4, time: NOW, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
            message({ modelID: "haiku", providerID: "anthropic", cost: 1, time: NOW, tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }),
          ],
        }),
      ],
      "7d",
      NOW,
    )
    expect(totals.cost).toBe(5)
    expect(totals.sessions).toBe(1)
    expect(totals.byModel).toHaveLength(2)
    expect(totals.byModel.find((row) => row.name === "opus")?.cost).toBe(4)
    expect(totals.byModel.find((row) => row.name === "haiku")?.cost).toBe(1)
  })
})

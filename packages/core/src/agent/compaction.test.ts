import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "../session/store"
import { compactSession, summarizeTimeoutMs } from "./compaction"

async function seed(events: MemoryEventStore, id: string, n: number): Promise<void> {
  await events.append(id, "Session.Created", { id, location: "/w", createdAt: Date.now() })
  for (let i = 0; i < n; i++) {
    await events.append(id, "Session.MessageAppended", {
      sessionId: id,
      message: { kind: i % 2 === 0 ? "user" : "assistant", id: `m${i}`, seq: i, text: `message ${i}`, content: i % 2 === 0 ? undefined : [{ type: "text", text: `message ${i}` }] },
    })
  }
}

describe("compactSession", () => {
  it("folds a long history into a compaction marker + durable boundary", async () => {
    const events = new MemoryEventStore()
    await seed(events, "s1", 30)
    const result = await compactSession(events, "s1", { retain: 10 })

    expect(result.boundarySeq).toBeGreaterThan(0)
    expect(result.summary).toContain("folded")
    const log = await events.read("s1")
    // A compaction marker message + the boundary event both landed.
    const marker = log.find((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { kind?: string } }).message?.kind === "compaction")
    expect(marker).toBeTruthy()
    const boundary = log.find((e) => e.type === "Session.Compacted")
    expect(boundary).toBeTruthy()
    expect((boundary?.data as { boundarySeq?: number }).boundarySeq).toBe(result.boundarySeq)
  })

  it("does not compact a small history (nothing to fold)", async () => {
    const events = new MemoryEventStore()
    await seed(events, "s2", 5)
    const result = await compactSession(events, "s2", { retain: 10 })
    expect(result.summary).toBe("")
    const log = await events.read("s2")
    expect(log.some((e) => e.type === "Session.Compacted")).toBe(false)
  })

  it("leaves the tail verbatim (retain) and folds only the head", async () => {
    const events = new MemoryEventStore()
    await seed(events, "s3", 20)
    const { summary } = await compactSession(events, "s3", { retain: 5 })
    expect(summary).toContain("15 messages folded") // 20 - 5
    const log = await events.read("s3")
    const tailTexts = log.filter((e) => e.type === "Session.MessageAppended").slice(-6).map((e) => (e.data as { message?: { text?: string } }).message?.text ?? "")
    // The last real messages (15..19) survive; the compaction marker is the
    // 6th-from-last entry.
    expect(tailTexts.join(",")).toContain("message 15")
    expect(tailTexts.join(",")).toContain("message 19")
  })
})

describe("compactSession LLM-summary seam", () => {
  it("uses the injected summarizer and falls back to the local marker on failure", async () => {
    const events = new MemoryEventStore()
    await seed(events, "s4", 20)
    const res = await compactSession(events, "s4", { retain: 5, summarize: async () => "the user asked about xs and got an answer about ys" })
    expect(res.summary).toContain("the user asked about xs")

    const events2 = new MemoryEventStore()
    await seed(events2, "s5", 20)
    const res2 = await compactSession(events2, "s5", { retain: 5, summarize: async () => { throw new Error("llm down") } })
    expect(res2.summary).toContain("folded") // local marker fallback
  })
})

describe("compaction tail byte budget (scale-aware, deadlock-free)", () => {
  it("folds when BYTES exceed the tail budget even though the COUNT fits retain (old code returned 'nothing to compact' forever)", async () => {
    const events = new MemoryEventStore()
    // 4 messages x ~5k chars: count 4 <= retain 12, but 20k chars > 8k budget.
    await events.append("s9", "Session.Created", { id: "s9", location: "/w", createdAt: Date.now() })
    for (let i = 0; i < 4; i++) {
      await events.append("s9", "Session.MessageAppended", { sessionId: "s9", message: { kind: "user", id: `u${i}`, seq: i, text: "x".repeat(5000) } })
    }
    const res = await compactSession(events, "s9", { retain: 12, maxTailChars: 8_000 })
    expect(res.boundarySeq).toBeGreaterThanOrEqual(0)
    const { messages } = (await import("./compaction")).projectCompacted(await events.read("s9"))
    const tailChars = messages.slice(1).reduce((n, m) => n + JSON.stringify(m).length, 0) // [1..] = kept tail ( [0] is the marker)
    expect(tailChars).toBeLessThanOrEqual(8_000)
  })

  it("caps the summarizer prompt at summarizeMaxChars", async () => {
    const events = new MemoryEventStore()
    await seed(events, "s10", 30)
    let promptLen = 0
    await compactSession(events, "s10", { retain: 2, summarizeMaxChars: 120, summarize: async (head) => { promptLen = head.length; return "ok" } })
    expect(promptLen).toBeLessThanOrEqual(120)
  })
})

it("summarizeTimeoutMs scales with the prompt (fixed 10s degraded big-head summaries)", () => {
  expect(summarizeTimeoutMs(1_000)).toBe(10_000) // floor
  expect(summarizeTimeoutMs(30_000)).toBe(12_000)
  expect(summarizeTimeoutMs(250_000)).toBe(100_000)
})

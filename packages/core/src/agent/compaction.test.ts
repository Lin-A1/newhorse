import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "../session/store"
import { compactSession } from "./compaction"

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

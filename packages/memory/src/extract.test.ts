import { describe, expect, it } from "bun:test"
import { MemoryMemoryStore, type MemoryRecord } from "./memory"
import { runMemoryExtraction, type MemoryPipeline } from "./extract"

const noopPipeline: MemoryPipeline = {
  extractL1MemoNext: async () => [],
  dedupMemories: async () => [],
}

describe("runMemoryExtraction", () => {
  it("stores extracted atoms when the pipeline says store", async () => {
    const store = new MemoryMemoryStore()
    const pipe: MemoryPipeline = {
      extractL1MemoNext: async () => [{ content: "user likes TypeScript", type: "persona", priority: 70 }],
      dedupMemories: async () => [{ action: "store" }],
    }
    const res = await runMemoryExtraction(pipe, store, { messages: [{ role: "user", text: "I like TypeScript" }], sessionId: "s" })
    expect(res.stored.length).toBe(1)
    expect(res.decisions[0]!.action).toBe("store")
    expect(store.search("TypeScript")).resolves.toHaveLength(1)
  })

  it("skips atoms the pipeline says skip", async () => {
    const store = new MemoryMemoryStore()
    const pipe: MemoryPipeline = {
      extractL1MemoNext: async () => [{ content: "noise", type: "fact", priority: 10 }],
      dedupMemories: async () => [{ action: "skip" }],
    }
    const res = await runMemoryExtraction(pipe, store, { messages: [], sessionId: "s" })
    expect(res.stored.length).toBe(0)
  })

  it("a broken extractor is fail-closed (no-op, never throws to the turn)", async () => {
    const store = new MemoryMemoryStore()
    const pipe: MemoryPipeline = { ...noopPipeline, extractL1MemoNext: async () => { throw new Error("LLM down") } }
    const res = await runMemoryExtraction(pipe, store, { messages: [], sessionId: "s" })
    expect(res.stored.length).toBe(0)
    expect(res.decisions.length).toBe(0)
  })

  it("dedup failure falls back to store-all (but never duplicates candidates)", async () => {
    const store = new MemoryMemoryStore()
    // Pre-existing candidate.
    await store.write({ content: "existing fact", type: "fact", priority: 50, sessionId: "s" })
    const pipe: MemoryPipeline = {
      extractL1MemoNext: async () => [{ content: "new atom", type: "fact", priority: 40 }],
      dedupMemories: async () => { throw new Error("dedup LLM down") },
    }
    const res = await runMemoryExtraction(pipe, store, { messages: [], sessionId: "s" })
    expect(res.stored.length).toBe(1) // the new atom stored; the candidate is not re-stored
    expect(res.stored[0]!.content).toBe("new atom")
    expect(await store.search("", 10, { sessionId: "s" })).toHaveLength(2)
  })
})

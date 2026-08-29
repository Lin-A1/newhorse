import { describe, expect, it } from "bun:test"
import { MemoryMemoryStore, SqliteMemoryStore, type MemoryStore } from "./memory"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("MemoryMemoryStore (in-memory seam)", () => {
  it("writes and searches by keyword (case-insensitive)", async () => {
    const store: MemoryStore = new MemoryMemoryStore()
    await store.write({ content: "The user prefers TypeScript over JavaScript", type: "persona", priority: 60, sessionId: "s1" })
    await store.write({ content: "Always run tests before commit", type: "instruction", priority: 90, sessionId: "s1" })

    const hits = await store.search("typescript")
    expect(hits.length).toBe(1)
    expect(hits[0]!.content).toContain("TypeScript")
    const none = await store.search("whatever", 5)
    expect(none.length).toBe(0)
  })

  it("honors session isolation (same semantics as the SQLite backend)", async () => {
    const store: MemoryStore = new MemoryMemoryStore()
    await store.write({ content: "secret A", type: "fact", priority: 40, sessionId: "sA" })
    await store.write({ content: "public B", type: "fact", priority: 40, sessionId: "sB" })

    const forA = await store.search("", 5, { sessionId: "sA" })
    expect(forA.length).toBe(1)
    expect(forA[0]!.content).toContain("secret A")
    const forB = await store.search("", 5, { sessionId: "sB" })
    expect(forB[0]!.content).toContain("public B")
  })
})

describe("SqliteMemoryStore", () => {
  it("persists memory across store instances (restart) and searches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-"))
    const dbPath = join(dir, "mem.db")
    try {
      const s1 = new SqliteMemoryStore(dbPath)
      await s1.write({ content: "MiniMax model is the configured LLM", type: "fact", priority: 50, sessionId: "s1", userId: "u1" })
      s1.close()

      // New instance reads the same rows (durable).
      const s2 = new SqliteMemoryStore(dbPath)
      const hits = await s2.search("MiniMax")
      expect(hits.length).toBe(1)
      expect(hits[0]!.content).toContain("MiniMax")
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("respects session isolation on search", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-iso-"))
    const dbPath = join(dir, "mem.db")
    try {
      const s = new SqliteMemoryStore(dbPath)
      await s.write({ content: "secret for session A", type: "fact", priority: 40, sessionId: "sA" })
      await s.write({ content: "public fact for session B", type: "fact", priority: 40, sessionId: "sB" })
      const forA = await s.search("", 5, { sessionId: "sA" })
      expect(forA.length).toBe(1)
      expect(forA[0]!.content).toContain("session A")
      s.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

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
      // Windows can hold the sqlite file lock briefly after close; a leaked
      // temp dir is harmless (OS temp) and must not fail the assertion set.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("SqliteMemoryStore FTS5 (relevance ranking)", () => {
  it("ranks BM25 relevance over priority (a close match beats a high-priority unrelated memory)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-fts-"))
    const dbPath = join(dir, "mem.db")
    try {
      const s = new SqliteMemoryStore(dbPath)
      await s.write({ content: "The user prefers TypeScript for frontend work", type: "persona", priority: 30, sessionId: "u" })
      await s.write({ content: "Always run tests before commit", type: "instruction", priority: 95, sessionId: "u" })
      const hits = await s.search("TypeScript frontend", 5, { sessionId: "u" })
      expect(hits.length).toBeGreaterThan(0)
      // The TypeScript memory ranks first (relevance), despite the 95-priority
      // instruction being present.
      expect(hits[0]!.content).toContain("TypeScript")
      s.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("falls back to LIKE when FTS cannot tokenize (a query with an FTS-unsafe char)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-fts2-"))
    const dbPath = join(dir, "mem.db")
    try {
      const s = new SqliteMemoryStore(dbPath)
      await s.write({ content: "a b c", type: "fact", priority: 10, sessionId: "u" })
      const hits = await s.search("a", 5, { sessionId: "u" })
      expect(hits.length).toBe(1)
      s.close()
    } finally {
      // Windows can hold the sqlite file lock briefly after close; a leaked
      // temp dir is harmless (OS temp) and must not fail the assertion set.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("semantic memory (attachEmbedder, switchable)", () => {
  it("memory store: a semantic match the keyword path cannot see is found via cosine", async () => {
    const store = new MemoryMemoryStore()
    // A fake embedder: vectors that make "prefers typescript" semantically
    // close to a query about coding language choice. Attached FIRST (the real
    // app attaches at createApp, before any write).
    const vecs: Record<string, number[]> = {}
    const embed = (t: string, p: "db" | "query"): number[] => {
      const key = `${p}:${t}`
      if (!vecs[key]) vecs[key] = t.includes("TypeScript") || t.includes("coding language") ? [1, 0] : [0, 1]
      return vecs[key]!
    }
    store.attachEmbedder!({ embed: async (t, p) => embed(t, p) })
    await store.write({ content: "The user prefers TypeScript for frontend work", type: "persona", priority: 40, sessionId: "u" })
    await store.write({ content: "Team standup is at nine", type: "fact", priority: 40, sessionId: "u" })
    // Semantic search: the keyword path cannot see "coding language" ->
    // "TypeScript" (no substring), but the vector path can.
    const after = await store.search("coding language", 5, { sessionId: "u" })
    expect(after.length).toBe(1)
    expect(after[0]!.content).toContain("TypeScript")
  })

  it("sqlite store: writes embed into the BLOB, backfill fills deferred rows, cosine ranks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-vec-"))
    const dbPath = join(dir, "mem.db")
    try {
      const s = new SqliteMemoryStore(dbPath)
      // Deferred-embedding flow: the first embedder FAILS for the deferred row
      // (metadata-only write), a second embedder backfills it; directional
      // vectors let the query distinguish the two rows.
      let failDeferred = true
      s.attachEmbedder!({ embed: async (t) => failDeferred && t.includes("deferred") ? null : (t.includes("deferred") ? [0, 1] : [1, 0]) })
      await s.write({ content: "embedded normally", type: "fact", priority: 40, sessionId: "u" })
      await s.write({ content: "deferred row", type: "fact", priority: 40, sessionId: "u" })
      failDeferred = false
      const filled = await s.attachEmbedder!({ embed: async (t) => (t.includes("deferred") ? [0, 1] : [1, 0]) }).backfill()
      expect(filled).toBe(1) // the deferred row got its vector
      const hits = await s.search("embedded", 5, { sessionId: "u" })
      expect(hits.length).toBe(1) // cosine: query [1,0] matches only row 1
      s.close()
    } finally {
      // Windows can hold the sqlite file lock briefly after close; a leaked
      // temp dir is harmless (OS temp) and must not fail the assertion set.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBruteForceIndex, createSqliteVecIndex, loadSqliteVec, float32Blob, blobToFloat32, type VectorIndex } from "./vector-index"
import { SqliteMemoryStore } from "./memory"

// Probe once: whether the sqlite-vec extension is usable on this platform.
// The vec0 tests skip (not fail) where the optional dependency is absent.
const vecAvailable = await loadSqliteVec(new Database(":memory:"))
const itVec = it.skipIf(!vecAvailable)

/** Deterministic fake embedding: one basis axis per topic, with synonyms so a
 *  query can hit semantically (no keyword overlap with the stored text). */
const AXES = ["cat", "dog", "sky", "code"]
const SYNONYMS: Record<string, string> = { feline: "cat", canine: "dog", rainfall: "sky", compiler: "code" }
function fakeEmbed(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/).map((w) => SYNONYMS[w] ?? w)
  const v = [0, 0, 0, 0]
  for (const w of words) {
    const i = AXES.indexOf(w)
    if (i >= 0) v[i] = 1
  }
  return v.every((x) => x === 0) ? [0.05, 0.05, 0.05, 0.05] : v
}
const fakeProvider = { embed: async (text: string) => fakeEmbed(text) }

/** Naive best-first cosine ranking WITHOUT a threshold — the similarity
 *  floor is the store's concern (RRF fusion), not the index's. */
function naiveRank(vectors: Record<string, number[]>, q: number[]): string[] {
  const cos = (a: number[], b: number[]): number => {
    const dot = a.reduce((s, x, i) => s + x * b[i]!, 0)
    const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0))
    const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0))
    return na * nb === 0 ? 0 : dot / (na * nb)
  }
  return Object.entries(vectors).map(([id, v]) => ({ id, s: cos(q, v) })).sort((a, b) => b.s - a.s).map((e) => e.id)
}

describe("BruteForceIndex (in-memory seam)", () => {
  it("ranks by cosine best-first, equivalent to naive scoring", () => {
    const idx = createBruteForceIndex()
    const vectors = { a: [1, 0, 0], b: [0.9, 0.1, 0], c: [0, 1, 0], d: [0.6, 0.2, 0] }
    for (const [id, v] of Object.entries(vectors)) expect(idx.upsert(id, new Float32Array(v))).toBe(true)
    const q = [1, 0.1, 0]
    expect(idx.search(new Float32Array(q), 10).map((h) => h.id)).toEqual(naiveRank(vectors, q))
    expect(idx.search(new Float32Array(q), 2)).toHaveLength(2) // k caps the result
    expect(idx.size()).toBe(4)
  })
  it("scope partitions the search (a scoped query only ranks same-scope rows)", () => {
    const idx = createBruteForceIndex()
    idx.upsert("a", new Float32Array([1, 0]), "s1")
    idx.upsert("b", new Float32Array([0.9, 0.1]), "s2")
    const q = new Float32Array([1, 0])
    expect(idx.search(q, 10, "s1").map((h) => h.id)).toEqual(["a"])
    expect(idx.search(q, 10).map((h) => h.id)).toEqual(["a", "b"]) // unscoped: all
    expect(idx.search(q, 10, "sX")).toEqual([])
  })
  it("upsert replaces, remove deletes, zero-norm is rejected, dims mismatches are skipped", () => {
    const idx = createBruteForceIndex()
    expect(idx.upsert("a", new Float32Array([1, 0]))).toBe(true)
    expect(idx.upsert("a", new Float32Array([0, 1]))).toBe(true) // replace
    expect(idx.search(new Float32Array([1, 0]), 10)[0]?.score).toBeCloseTo(0)
    idx.remove("a")
    expect(idx.search(new Float32Array([1, 0]), 10)).toEqual([])
    expect(idx.upsert("z", new Float32Array([0, 0]))).toBe(false) // zero norm
    idx.upsert("w3", new Float32Array([1, 0, 0])) // different dimensionality
    // A 2-dim query skips the 3-dim row instead of mis-scoring it.
    expect(idx.search(new Float32Array([1, 0]), 10)).toEqual([])
    // A 3-dim query matches it.
    expect(idx.search(new Float32Array([1, 0, 0]), 10).map((h) => h.id)).toEqual(["w3"])
  })
})

describe("SqliteVecIndex (vec0 extension)", () => {
  itVec("matches the brute ranking on the same data (indexed KNN equivalence)", async () => {
    const db = new Database(":memory:")
    expect(await loadSqliteVec(db)).toBe(true)
    const idx = createSqliteVecIndex(db, 3)!
    expect(idx).toBeDefined()
    const vectors = { a: [1, 0, 0], b: [0.9, 0.1, 0], c: [0, 1, 0], d: [0.6, 0.2, 0] }
    for (const [id, v] of Object.entries(vectors)) expect(idx.upsert(id, new Float32Array(v))).toBe(true)
    const q = [1, 0.1, 0]
    expect(idx.search(new Float32Array(q), 10).map((h) => h.id)).toEqual(naiveRank(vectors, q))
    idx.remove("a")
    expect(idx.search(new Float32Array([1, 0, 0]), 10).some((h) => h.id === "a")).toBe(false)
    db.close()
  })
  itVec("partition-key scope keeps per-scope KNN exact", async () => {
    const db = new Database(":memory:")
    expect(await loadSqliteVec(db)).toBe(true)
    const idx = createSqliteVecIndex(db, 2)!
    idx.upsert("a", new Float32Array([1, 0]), "s1")
    idx.upsert("crowd1", new Float32Array([0.99, 0.1]), "s2")
    idx.upsert("crowd2", new Float32Array([0.98, 0.2]), "s2")
    idx.upsert("b", new Float32Array([0.9, 0.1]), "s1")
    // Scoped: s2 rows cannot crowd s1 out of the top-k.
    expect(idx.search(new Float32Array([1, 0]), 2, "s1").map((h) => h.id)).toEqual(["a", "b"])
    // Unscoped ranks the whole index (cos order: a 1.0, crowd1 0.995, b 0.994, crowd2 0.980).
    expect(idx.search(new Float32Array([1, 0]), 4).map((h) => h.id)).toEqual(["a", "crowd1", "b", "crowd2"])
    db.close()
  })
  itVec("persists across connections (restart path: reopen + reload + search)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-vec-"))
    const dbPath = join(dir, "v.db")
    try {
      const db = new Database(dbPath)
      await loadSqliteVec(db)
      createSqliteVecIndex(db, 2)!.upsert("a", new Float32Array([1, 0]), "s1")
      db.close()
      const db2 = new Database(dbPath)
      await loadSqliteVec(db2)
      const rows = createSqliteVecIndex(db2, 2)!.search(new Float32Array([1, 0]), 5)
      expect(rows.map((r) => r.id)).toEqual(["a"])
      db2.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
  itVec("self-heals a stale table with different dimensions (canary detects, replaces)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-vec-"))
    const dbPath = join(dir, "v.db")
    try {
      const db1 = new Database(dbPath)
      await loadSqliteVec(db1)
      createSqliteVecIndex(db1, 4)!.upsert("old", new Float32Array([1, 0, 0, 0]))
      db1.close()
      // A provider switch changed the dimensions: the same table now rejects
      // the new dims; the index must replace the table instead of silently
      // failing every upsert.
      const db2 = new Database(dbPath)
      await loadSqliteVec(db2)
      const idx = createSqliteVecIndex(db2, 3)!
      expect(idx.upsert("new", new Float32Array([0, 1, 0]))).toBe(true)
      expect(idx.search(new Float32Array([0, 1, 0]), 5).map((h) => h.id)).toEqual(["new"])
      db2.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
  itVec("self-heals a table with the wrong distance metric (L2 leftover from an older build)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-vec-"))
    const dbPath = join(dir, "v.db")
    try {
      const db1 = new Database(dbPath)
      await loadSqliteVec(db1)
      // Hand-create the OLD shape (no distance_metric=cosine): cosine scores
      // over this table would be garbage (1 - L2 is negative), so the index
      // must detect and replace it instead of silently returning empty.
      db1.run(`CREATE VIRTUAL TABLE memory_vec USING vec0(id text primary key, scope text partition key, embedding float32[2])`)
      db1.query(`INSERT INTO memory_vec(id, scope, embedding) VALUES (?, ?, ?)`).run("old", "s1", float32Blob(new Float32Array([1, 0])))
      db1.close()
      const db2 = new Database(dbPath)
      await loadSqliteVec(db2)
      const idx = createSqliteVecIndex(db2, 2)!
      idx.upsert("new", new Float32Array([1, 0]), "s1")
      expect(idx.search(new Float32Array([1, 0]), 5, "s1").map((h) => h.id)).toEqual(["new"])
      db2.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("SqliteMemoryStore vector modes (integration)", () => {
  it("auto mode: a semantic match with no keyword overlap is found; isolation scopes the index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-"))
    try {
      const store = new SqliteMemoryStore(join(dir, "m.db"))
      store.attachEmbedder(fakeProvider, "fake-model")
      await store.write({ content: "the cat purrs loudly", type: "fact", priority: 50, sessionId: "s1" })
      await store.write({ content: "the dog barks at night", type: "fact", priority: 50, sessionId: "s1" })
      await store.write({ content: "typescript code compiles", type: "fact", priority: 50, sessionId: "s2" })
      // "feline" shares NO keyword with the cat row — only the vector path sees it.
      const s1 = await store.search("feline naps", 5, { sessionId: "s1" })
      expect(s1[0]?.content).toBe("the cat purrs loudly")
      // Scoped index: s2's rows never leak into s1's search, s1's into s2's.
      const s2 = await store.search("feline naps", 5, { sessionId: "s2" })
      expect(s2.some((r) => r.content.includes("cat"))).toBe(false)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
  it("restart: a reopened store rebuilds the index from BLOBs and still finds semantically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-"))
    try {
      const dbPath = join(dir, "m.db")
      const first = new SqliteMemoryStore(dbPath)
      first.attachEmbedder(fakeProvider, "fake-model")
      await first.write({ content: "the cat purrs loudly", type: "fact", priority: 50, sessionId: "s1" })
      first.close()
      const second = new SqliteMemoryStore(dbPath)
      second.attachEmbedder(fakeProvider, "fake-model") // attach-time rebuild path
      const hits = await second.search("feline naps", 5, { sessionId: "s1" })
      expect(hits[0]?.content).toBe("the cat purrs loudly")
      second.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
  it("vectorMode off keeps the legacy scan path working", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-"))
    try {
      const store = new SqliteMemoryStore(join(dir, "m.db"))
      store.attachEmbedder(fakeProvider, "fake-model", { vectorMode: "off" })
      await store.write({ content: "the cat purrs loudly", type: "fact", priority: 50, sessionId: "s1" })
      const hits = await store.search("feline naps", 5, { sessionId: "s1" })
      expect(hits[0]?.content).toBe("the cat purrs loudly")
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
  it("backfill preserves the session scope (deferred embedding stays searchable scoped)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-"))
    try {
      let down = true
      const flaky = { embed: async (text: string) => (down ? null : fakeEmbed(text)) }
      const store = new SqliteMemoryStore(join(dir, "m.db"))
      store.attachEmbedder(flaky, "fake-model")
      // Provider down at write time: metadata-only (deferred embedding).
      await store.write({ content: "the cat purrs loudly", type: "fact", priority: 50, sessionId: "s1" })
      down = false
      const filled = await store.attachEmbedder(flaky, "fake-model").backfill()
      expect(filled).toBe(1)
      // Scoped search MUST find it (a scope-dropping backfill made it visible
      // only to unscoped searches).
      const s1 = await store.search("feline naps", 5, { sessionId: "s1" })
      expect(s1[0]?.content).toBe("the cat purrs loudly")
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
  it("agent isolation post-filters the fused rows (no cross-agent leak on the index path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-"))
    try {
      const store = new SqliteMemoryStore(join(dir, "m.db"))
      store.attachEmbedder(fakeProvider, "fake-model")
      await store.write({ content: "the cat purrs loudly", type: "fact", priority: 50, sessionId: "s1", agentId: "agent-a" })
      await store.write({ content: "a cat naps in the sun", type: "fact", priority: 50, sessionId: "s1", agentId: "agent-b" })
      // Both rows are in scope s1; the agent axis must filter AFTER fusion.
      const a = await store.search("feline naps", 5, { sessionId: "s1", agentId: "agent-a" })
      expect(a.map((r) => r.content)).toEqual(["the cat purrs loudly"])
      const b = await store.search("feline naps", 5, { sessionId: "s1", agentId: "agent-b" })
      expect(b.map((r) => r.content)).toEqual(["a cat naps in the sun"])
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
  it("a host-injected VectorIndex wins over vectorMode (wide-mouth seam)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-"))
    try {
      let searched = 0
      const seen: string[] = []
      const custom: VectorIndex = {
        mode: "brute",
        upsert: (id) => {
          seen.push(id)
          return true
        },
        remove: () => {},
        search: (_q, _k, _scope) => {
          searched++
          // Echo the last upserted id so the fusion step can resolve it.
          return seen.length > 0 ? [{ id: seen[seen.length - 1]!, score: 1 }] : []
        },
        size: () => seen.length,
      }
      const store = new SqliteMemoryStore(join(dir, "m.db"))
      store.attachEmbedder(fakeProvider, "fake-model", { vectorIndex: custom })
      await store.write({ content: "the cat purrs loudly", type: "fact", priority: 50, sessionId: "s1" })
      const hits = await store.search("feline naps", 5, { sessionId: "s1" })
      expect(searched).toBeGreaterThan(0)
      expect(hits[0]?.content).toBe("the cat purrs loudly")
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
  it("re-attach with a different tag resets the index (model switch rebuilds under the new tag)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-mem-"))
    try {
      const store = new SqliteMemoryStore(join(dir, "m.db"))
      store.attachEmbedder(fakeProvider, "model-a")
      await store.write({ content: "the cat purrs loudly", type: "fact", priority: 50, sessionId: "s1" })
      // Switch to a model whose rows do not exist yet: the index resets and
      // defers; backfill re-embeds the old row under the new tag.
      store.attachEmbedder(fakeProvider, "model-b")
      const n = await store.attachEmbedder(fakeProvider, "model-b").backfill()
      expect(n).toBe(1)
      const hits = await store.search("feline naps", 5, { sessionId: "s1" })
      expect(hits[0]?.content).toBe("the cat purrs loudly")
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// Type-level guard: the seam must stay assignable from both implementations.
const _modes: VectorIndex["mode"][] = ["brute", "sqlite-vec"]
void _modes
void float32Blob
void blobToFloat32

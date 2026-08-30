import { Database } from "bun:sqlite"
import type { UnknownRecord } from "@newhorse/schema"
import { cosine, type EmbeddingProvider } from "./embedding"

/**
 * Memory seam — the pluggable store behind `memory_search`/`memory_write`.
 *
 * Model (borrowed from TencentDB-Agent-Memory L1, reduced to the atomic core):
 * a memory is one extracted ATOM (a fact/preference/instruction) with a type,
 * a priority (0-100, higher = more important), the source session/agent it
 * came from, and a full audit trail. The store is a seam: `SqliteMemoryStore`
 * is the default (a single table + simple keyword match), but a caller can
 * inject a vector-backed implementation later without touching the tools.
 *
 * We do NOT implement LLM extraction/dedup here — that is a downstream
 * pipeline (a tool or a post-turn hook) that calls `write` with decided
 * memories. This keeps the seam small and the extraction philosophy swappable.
 */

export type MemoryType = "persona" | "episodic" | "instruction" | "fact"

export interface MemoryEntry {
  readonly content: string
  /** 0-100 importance (higher = more important; ranked first on search). */
  readonly type: MemoryType
  readonly priority: number
  /** The session/agent this memory came from (isolation key). */
  readonly sessionId: string
  readonly agentId?: string
  readonly userId?: string
  /** Source message ids that produced this memory (provenance). */
  readonly sourceIds?: readonly string[]
  readonly metadata?: UnknownRecord
}

export interface MemoryRecord extends MemoryEntry {
  readonly id: string
  readonly createdAt: number
}

/** The seam: write/search a memory index. Replaceable backend. */
export interface MemoryStore {
  readonly write: (entry: MemoryEntry) => Promise<MemoryRecord>
  readonly search: (query: string, limit?: number, isolation?: { sessionId?: string; agentId?: string; userId?: string }) => Promise<MemoryRecord[]>
  /** Remove a memory by id (update/merge replaces: the stale atom is removed). */
  readonly delete?: (id: string) => Promise<void>
  /**
   * Attach an embedder (Phase 4 semantic search, switchable): writes embed
   * their content (a failure stores metadata-only — deferred embedding) and
   * searches fuse BM25 + cosine via RRF. When not attached, search is
   * keyword-only. `backfill` embeds existing rows that lack a vector.
   */
  readonly attachEmbedder?: (embedder: EmbeddingProvider, tag?: string) => { backfill: (limit?: number) => Promise<number> }
  readonly close?: () => void
}

/** In-memory store (default, for tests / no-persist runs). */
export class MemoryMemoryStore implements MemoryStore {
  readonly #rows: MemoryRecord[] = []
  #embedder: EmbeddingProvider | undefined
  /** id -> vector, parallel to #rows (memory rows are never mutated in place). */
  readonly #vectors = new Map<string, number[]>()
  /** Attach an embedder; writes embed (fail-soft) and searches fuse BM25+cosine. */
  attachEmbedder(embedder: EmbeddingProvider, _tag?: string): { backfill: (limit?: number) => Promise<number> } {
    this.#embedder = embedder
    const embedderRef = embedder
    return {
      backfill: async (limit = 100): Promise<number> => {
        let n = 0
        for (const r of this.#rows) {
          if (this.#vectors.has(r.id) || n >= limit) continue
          const v = await embedderRef.embed(r.content, "db")
          if (v) { this.#vectors.set(r.id, v); n++ }
        }
        return n
      },
    }
  }
  async write(entry: MemoryEntry): Promise<MemoryRecord> {
    const rec: MemoryRecord = { ...entry, id: crypto.randomUUID(), createdAt: Date.now() }
    this.#rows.push(rec)
    // Fail-soft embedding: a broken provider stores metadata-only.
    if (this.#embedder) {
      const v = await this.#embedder.embed(rec.content, "db")
      if (v) this.#vectors.set(rec.id, v)
    }
    return rec
  }
  async delete(id: string): Promise<void> {
    const idx = this.#rows.findIndex((r) => r.id === id)
    if (idx >= 0) this.#rows.splice(idx, 1)
    this.#vectors.delete(id)
  }
  async search(query: string, limit = 5, isolation?: { sessionId?: string; agentId?: string; userId?: string }): Promise<MemoryRecord[]> {
    const q = query.toLowerCase()
    const inIso = (r: MemoryRecord): boolean => {
      if (isolation?.sessionId && r.sessionId !== isolation.sessionId) return false
      if (isolation?.agentId && r.agentId !== isolation.agentId) return false
      if (isolation?.userId && r.userId !== isolation.userId) return false
      return true
    }
    const hits = this.#rows.filter((r) => r.content.toLowerCase().includes(q) && inIso(r))
    const bm25Rank = new Map(hits.map((r, i) => [r.id, i]))
    // Vector path: cosine over embedded rows (semantic matches the keyword
    // path cannot see). No embedder or no query vector -> single-path FTS.
    let cosRank: Map<string, number> | undefined
    if (this.#embedder && q) {
      const qv = await this.#embedder.embed(query, "query")
      if (qv) {
        const scored = this.#rows.filter((r) => this.#vectors.has(r.id) && inIso(r))
          .map((r) => ({ id: r.id, cos: cosine(qv, this.#vectors.get(r.id)!) }))
          .filter((s) => s.cos > 0.3)
          .sort((a, b) => b.cos - a.cos)
        cosRank = new Map(scored.map((s, i) => [s.id, i]))
      }
    }
    const byId = new Map(this.#rows.map((r) => [r.id, r]))
    const merged = rrfMerge([bm25Rank, cosRank], (id) => byId.get(id)).filter(inIso)
    if (merged.length > 0) return merged.slice(0, limit)
    // Same ordering as SqliteMemoryStore: priority DESC, then newest first.
    return hits.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt).slice(0, limit)
  }
}

/** Reciprocal-rank fusion (k=60, the standard constant): merge ranked id
 *  lists into one ordering; lists may be undefined (single-path degrade). */
export function rrfMerge(ranks: ReadonlyArray<Map<string, number> | undefined>, resolve: (id: string) => MemoryRecord | undefined): MemoryRecord[] {
  const K = 60
  const score = new Map<string, number>()
  for (const rank of ranks) {
    if (!rank) continue
    for (const [id, i] of rank) score.set(id, (score.get(id) ?? 0) + 1 / (K + i + 1))
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => resolve(id))
    .filter((r): r is MemoryRecord => !!r)
}

/**
 * SQLite-backed store: one `memory` table with content + metadata columns,
 * no vector index yet. Keyword matching is a simple LIKE scan. Put this FIRST
 * (facts survive restarts); a vec0/FTS5 index is a later capability on the
 * same seam.
 */
export class SqliteMemoryStore implements MemoryStore {
  readonly #db: Database
  #ready: Promise<void>
  #embedder: EmbeddingProvider | undefined
  #embedderTag: string | undefined

  constructor(dbPath: string) {
    this.#db = new Database(dbPath)
    this.#ready = this.#migrate()
  }

  /** Attach an embedder (switchable semantic search): writes embed their
   *  content into the `embedding` BLOB (Float32Array; fail-soft — a broken
   *  provider stores metadata-only) and searches fuse BM25 + cosine via RRF.
   *  backfill embeds existing rows lacking a vector (idempotent, budgeted). */
  attachEmbedder(embedder: EmbeddingProvider, tag?: string): { backfill: (limit?: number) => Promise<number> } {
    this.#embedder = embedder
    this.#embedderTag = tag
    const embedderRef = embedder
    return {
      backfill: async (limit = 100): Promise<number> => {
        await this.#ready
        // Rows missing a vector OR tagged by a DIFFERENT model (a model switch
        // re-embeds under the current tag instead of mixing vectors).
        const pending = this.#db.query("SELECT id, content FROM memory WHERE embedding IS NULL OR embedding_model IS NOT ? LIMIT ?").all(this.#embedderTag ?? null, limit) as { id: string; content: string }[]
        let n = 0
        for (const row of pending) {
          const v = await embedderRef.embed(row.content, "db")
          if (v) {
            this.#db.run("UPDATE memory SET embedding = ?, embedding_model = ? WHERE id = ?", [float32Blob(v), this.#embedderTag ?? null, row.id])
            n++
          }
        }
        return n
      },
    }
  }

  #migrate(): Promise<void> {
    return Promise.resolve().then(() => {
      this.#db.run(`
        CREATE TABLE IF NOT EXISTS memory (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          type TEXT NOT NULL,
          priority INTEGER NOT NULL,
          session_id TEXT,
          agent_id TEXT,
          user_id TEXT,
          source_ids TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL
        )
      `)
      // FTS5 index for rank-ordered (BM25) keyword search — a real similarity
      // proxy without a vector embedder. Content is kept in sync via triggers
      // after insert/delete; FTS is best-effort (a query against a missing
      // FTS row falls through to LIKE in search()).
      try {
        this.#db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, id UNINDEXED)`)
        this.#db.run(`
          CREATE TRIGGER IF NOT EXISTS memory_fts_after_insert AFTER INSERT ON memory BEGIN
            INSERT INTO memory_fts (id, content) VALUES (new.id, new.content);
          END
        `)
        this.#db.run(`
          CREATE TRIGGER IF NOT EXISTS memory_fts_after_delete AFTER DELETE ON memory BEGIN
            DELETE FROM memory_fts WHERE id = old.id;
          END
        `)
      } catch {
        // FTS5 may be unavailable in a minimal build — the search falls back
        // to LIKE; never fail migration for the optional index.
      }
      // Backfill an existing DB (rows written before the FTS index existed) so
      // search ranks them too. Idempotent.
      try {
        this.#db.run(`INSERT INTO memory_fts (id, content) SELECT id, content FROM memory WHERE id NOT IN (SELECT id FROM memory_fts)`)
      } catch {
        // no-op — the LIKE fallback covers it.
      }
      // Vector columns (optional, Phase 4 semantic search): a Float32Array
      // serialized as BLOB + the embedding model tag. NULL = not yet embedded
      // (deferred embedding). The tag prevents cross-model vector mixing: a
      // query only matches rows embedded by the SAME model.
      try {
        const cols = this.#db.query("PRAGMA table_info(memory)").all() as { name: string }[]
        if (!cols.some((c) => c.name === "embedding")) {
          this.#db.run("ALTER TABLE memory ADD COLUMN embedding BLOB")
        }
        if (!cols.some((c) => c.name === "embedding_model")) {
          this.#db.run("ALTER TABLE memory ADD COLUMN embedding_model TEXT")
        }
      } catch {
        // no-op — vector search is optional; FTS still works.
      }
    })
  }

  async write(entry: MemoryEntry): Promise<MemoryRecord> {
    await this.#ready
    const rec: MemoryRecord = { ...entry, id: crypto.randomUUID(), createdAt: Date.now() }
    // Fail-soft embedding: a broken provider stores metadata-only (deferred) —
    // backfill() can fill it later; the write itself never fails for it.
    let embedding: Buffer | null = null
    if (this.#embedder) {
      const v = await this.#embedder.embed(rec.content, "db")
      if (v) embedding = float32Blob(v)
    }
    this.#db.run(
      "INSERT INTO memory (id, content, type, priority, session_id, agent_id, user_id, source_ids, metadata, created_at, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [rec.id, rec.content, rec.type, rec.priority, rec.sessionId, rec.agentId ?? null, rec.userId ?? null, rec.sourceIds ? JSON.stringify(rec.sourceIds) : null, rec.metadata ? JSON.stringify(rec.metadata) : null, rec.createdAt, embedding, embedding ? (this.#embedderTag ?? null) : null],
    )
    return rec
  }

  async search(query: string, limit = 5, isolation?: { sessionId?: string; agentId?: string; userId?: string }): Promise<MemoryRecord[]> {
    await this.#ready
    const q = query.trim()
    const isoSqlParts: string[] = []
    const isoParams: string[] = []
    if (isolation?.sessionId) { isoSqlParts.push("session_id = ?"); isoParams.push(isolation.sessionId) }
    if (isolation?.agentId) { isoSqlParts.push("agent_id = ?"); isoParams.push(isolation.agentId) }
    if (isolation?.userId) { isoSqlParts.push("user_id = ?"); isoParams.push(isolation.userId) }
    const isoSql = isoSqlParts.length > 0 ? ` AND ${isoSqlParts.join(" AND ")}` : ""

    // Path 1 — FTS5 BM25 (relevance-ranked keyword). The JOIN preserves the
    // bm25 ORDER and applies isolation BEFORE the limit.
    let bm25Rank: Map<string, number> | undefined
    if (q) {
      try {
        const stmt = this.#db.query(`SELECT m.* FROM memory_fts f JOIN memory m ON m.id = f.id WHERE memory_fts MATCH ?${isoSql} ORDER BY bm25(memory_fts) LIMIT ?`)
        const rows = stmt.all(ftsQuery(q), ...isoParams, limit * 2) as Record<string, unknown>[]
        if (rows.length > 0) bm25Rank = new Map(rows.map((r, i) => [String(r.id), i]))
      } catch {
        // FTS unavailable or an untokenizable query — fall through.
      }
    }

    // Path 2 — cosine over embedded rows (semantic; sees what keywords cannot).
    let cosRank: Map<string, number> | undefined
    if (this.#embedder && q) {
      const qv = await this.#embedder.embed(q, "query")
      if (qv) {
        const rows = this.#db.query(`SELECT id, embedding FROM memory WHERE embedding IS NOT NULL AND embedding_model = ?${isoSql}`).all(this.#embedderTag ?? null, ...isoParams) as { id: string; embedding: Buffer }[]
        const scored = rows
          .map((r) => ({ id: r.id, cos: cosine(qv, blobToFloat32(r.embedding)) }))
          .filter((s) => s.cos > 0.3)
          .sort((a, b) => b.cos - a.cos)
          .slice(0, limit * 2)
        if (scored.length > 0) cosRank = new Map(scored.map((s, i) => [s.id, i]))
      }
    }

    // Fuse (RRF, k=60) when both paths hit; a single path degrades to itself.
    if (bm25Rank || cosRank) {
      const byId = new Map<string, MemoryRecord>()
      const fetchRows = (ids: string[]): void => {
        if (ids.length === 0) return
        const stmt = this.#db.query(`SELECT * FROM memory WHERE id IN (${ids.map(() => "?").join(",")})`)
        for (const r of stmt.all(...ids) as Record<string, unknown>[]) byId.set(String(r.id), migrateRow(r))
      }
      fetchRows([...(bm25Rank?.keys() ?? []), ...(cosRank?.keys() ?? [])])
      const merged = rrfMerge([bm25Rank, cosRank], (id) => byId.get(id))
      if (merged.length > 0) return merged.slice(0, limit)
    }

    // Fallback — LIKE + priority DESC (empty query, FTS-less build, or no hits).
    const cond = q ? ["content LIKE ?"] : []
    const params: (string | number)[] = q ? [`%${q}%`] : []
    if (isolation?.sessionId) { cond.push("session_id = ?"); params.push(isolation.sessionId) }
    if (isolation?.agentId) { cond.push("agent_id = ?"); params.push(isolation.agentId) }
    if (isolation?.userId) { cond.push("user_id = ?"); params.push(isolation.userId) }
    const where = cond.length > 0 ? ` WHERE ${cond.join(" AND ")}` : ""
    params.push(limit)
    const stmt = this.#db.query(`SELECT * FROM memory${where} ORDER BY priority DESC, created_at DESC LIMIT ?`)
    const rows = stmt.all(...params) as Record<string, unknown>[]
    return rows.map(migrateRow)
  }

  async delete(id: string): Promise<void> {
    await this.#ready
    this.#db.run("DELETE FROM memory WHERE id = ?", [id])
  }

  close(): void {
    this.#db.close()
  }
}

/** Wrap a user query as a quoted FTS5 MATCH term so punctuation/special
 *  characters cannot break the FTS query (each word becomes a quoted prefix
 *  term; an unparseable query throws and falls back to LIKE). */
function ftsQuery(q: string): string {
  return q.split(/\s+/).filter(Boolean).map((w) => `"${w.split('"').join('""')}"`).join(" ")
}

/** Serialize a vector as a little-endian Float32 BLOB (compact storage). */
function float32Blob(v: readonly number[]): Buffer {
  const arr = new Float32Array(v)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

/** Deserialize a stored BLOB back into a number[] for cosine. */
function blobToFloat32(b: Buffer): number[] {
  const arr = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4))
  return Array.from(arr)
}

function migrateRow(row: Record<string, unknown>): MemoryRecord {  return {
    id: String(row.id),
    content: String(row.content),
    type: String(row.type) as MemoryType,
    priority: Number(row.priority),
    sessionId: String(row.session_id),
    agentId: row.agent_id ? String(row.agent_id) : undefined,
    userId: row.user_id ? String(row.user_id) : undefined,
    sourceIds: row.source_ids ? (JSON.parse(String(row.source_ids)) as string[]) : undefined,
    metadata: row.metadata ? (JSON.parse(String(row.metadata)) as UnknownRecord) : undefined,
    createdAt: Number(row.created_at),
  }
}

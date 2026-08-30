import { Database } from "bun:sqlite"
import type { UnknownRecord } from "@newhorse/schema"

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
  readonly close?: () => void
}

/** In-memory store (default, for tests / no-persist runs). */
export class MemoryMemoryStore implements MemoryStore {
  readonly #rows: MemoryRecord[] = []
  async write(entry: MemoryEntry): Promise<MemoryRecord> {
    const rec: MemoryRecord = { ...entry, id: crypto.randomUUID(), createdAt: Date.now() }
    this.#rows.push(rec)
    return rec
  }
  async delete(id: string): Promise<void> {
    const idx = this.#rows.findIndex((r) => r.id === id)
    if (idx >= 0) this.#rows.splice(idx, 1)
  }
  async search(query: string, limit = 5, isolation?: { sessionId?: string; agentId?: string; userId?: string }): Promise<MemoryRecord[]> {
    const q = query.toLowerCase()
    const hits = this.#rows.filter((r) => {
      if (!r.content.toLowerCase().includes(q)) return false
      if (isolation?.sessionId && r.sessionId !== isolation.sessionId) return false
      if (isolation?.agentId && r.agentId !== isolation.agentId) return false
      if (isolation?.userId && r.userId !== isolation.userId) return false
      return true
    })
    // Same ordering as SqliteMemoryStore: priority DESC, then newest first.
    return hits.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt).slice(0, limit)
  }
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

  constructor(dbPath: string) {
    this.#db = new Database(dbPath)
    this.#ready = this.#migrate()
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
    })
  }

  async write(entry: MemoryEntry): Promise<MemoryRecord> {
    await this.#ready
    const rec: MemoryRecord = { ...entry, id: crypto.randomUUID(), createdAt: Date.now() }
    this.#db.run(
      "INSERT INTO memory (id, content, type, priority, session_id, agent_id, user_id, source_ids, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [rec.id, rec.content, rec.type, rec.priority, rec.sessionId, rec.agentId ?? null, rec.userId ?? null, rec.sourceIds ? JSON.stringify(rec.sourceIds) : null, rec.metadata ? JSON.stringify(rec.metadata) : null, rec.createdAt],
    )
    return rec
  }

  async search(query: string, limit = 5, isolation?: { sessionId?: string; agentId?: string; userId?: string }): Promise<MemoryRecord[]> {
    await this.#ready
    const q = query.trim()
    // FTS5 BM25 first (relevance-ranked — the similarity proxy). The JOIN
    // preserves the bm25 ORDER and applies the isolation filter BEFORE the
    // limit (the earlier two-step id-IN re-ordered by created_at and could
    // under-deliver under isolation). Fall back to LIKE when FTS misses.
    if (q) {
      try {
        const isoFts: string[] = []
        const isoParams: string[] = []
        if (isolation?.sessionId) { isoFts.push("m.session_id = ?"); isoParams.push(isolation.sessionId) }
        if (isolation?.agentId) { isoFts.push("m.agent_id = ?"); isoParams.push(isolation.agentId) }
        if (isolation?.userId) { isoFts.push("m.user_id = ?"); isoParams.push(isolation.userId) }
        const isoSql = isoFts.length > 0 ? ` AND ${isoFts.join(" AND ")}` : ""
        const stmt = this.#db.query(`SELECT m.* FROM memory_fts f JOIN memory m ON m.id = f.id WHERE memory_fts MATCH ?${isoSql} ORDER BY bm25(memory_fts) LIMIT ?`)
        const rows = stmt.all(ftsQuery(q), ...isoParams, limit) as Record<string, unknown>[]
        if (rows.length > 0) return rows.map(migrateRow)
      } catch {
        // FTS unavailable or an untokenizable query — fall through to LIKE.
      }
    }
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

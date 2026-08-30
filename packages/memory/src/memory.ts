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

function migrateRow(row: Record<string, unknown>): MemoryRecord {
  return {
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

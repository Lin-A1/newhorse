import { Database } from "bun:sqlite"
import type { StoredEvent, UnknownRecord, AggregateType } from "@newhorse/schema"
import type { EventStore } from "./store"

/**
 * SQLite-backed event store.
 *
 * Uses bun:sqlite (zero-dependency, native). A per-aggregate monotonically
 * increasing sequence is held in a dedicated `event_sequence` row so concurrent
 * appends cannot collide on `seq` (unlike a `length`-based allocator that is
 * only safe while appends never interleave an await). The durable shape stays
 * `(aggregate_id, seq, type, data)`.
 *
 * This is the drop-in backend for the same `EventStore` the in-memory store
 * implements, so session/session-input logic never changes.
 */
export class SqliteEventStore implements EventStore {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
    this.#migrate()
  }

  static open(path: string): SqliteEventStore {
    return new SqliteEventStore(new Database(path))
  }

  #migrate(): void {
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS event (
        aggregate_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        aggregate TEXT NOT NULL DEFAULT 'session',
        PRIMARY KEY (aggregate_id, seq)
      )
    `)
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS event_sequence (
        aggregate_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL
      )
    `)
  }

  async append<T extends UnknownRecord>(aggregate_id: string, type: string, data: T, aggregate: AggregateType = "session"): Promise<StoredEvent> {
    const seq = this.#nextSeq(aggregate_id)
    this.#db.run("INSERT INTO event (aggregate_id, seq, type, data, aggregate) VALUES (?, ?, ?, ?, ?)", [aggregate_id, seq, type, JSON.stringify(data), aggregate])
    return { aggregate, aggregate_id, seq, type, data }
  }

  async read(aggregate_id: string): Promise<StoredEvent[]> {
    const rows = this.#db.query("SELECT seq, type, data, aggregate FROM event WHERE aggregate_id = ? ORDER BY seq ASC").all(aggregate_id) as { seq: number; type: string; data: string; aggregate: AggregateType }[]
    return rows.map((r) => ({ aggregate: r.aggregate, aggregate_id, seq: r.seq, type: r.type, data: JSON.parse(r.data) as UnknownRecord }))
  }

  async latestSeq(aggregate_id: string): Promise<number> {
    const row = this.#db.query("SELECT seq FROM event_sequence WHERE aggregate_id = ?").get(aggregate_id) as { seq: number } | null
    return row ? row.seq : -1
  }

  async aggregateIds(): Promise<string[]> {
    const rows = this.#db.query("SELECT DISTINCT aggregate_id FROM event").all() as { aggregate_id: string }[]
    return rows.map((r) => r.aggregate_id)
  }

  #nextSeq(aggregate_id: string): number {
    // Atomic per-aggregate increment: a single INSERT ... ON CONFLICT that bumps
    // `seq` and returns it, so the read + write never interleave and two different
    // connections/processes appending to the same aggregate cannot collide (a
    // prior SELECT-then-UPSERT was TOCTOU and could assign the same seq twice).
    const row = this.#db
      .query("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, 0) ON CONFLICT(aggregate_id) DO UPDATE SET seq = seq + 1 RETURNING seq")
      .get(aggregate_id) as { seq: number } | null
    return row ? row.seq : 0
  }

  close(): void {
    this.#db.close()
  }
}

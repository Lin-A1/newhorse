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
    // A DB created by a build predating the `aggregate` column has an `event`
    // table WITHOUT it; CREATE TABLE IF NOT EXISTS does not alter an existing
    // table, so read/append would throw `no such column: aggregate`. Add the
    // column (and backfill a default) only when it is absent.
    const cols = this.#db.query("PRAGMA table_info(event)").all() as { name: string }[]
    if (!cols.some((c) => c.name === "aggregate")) {
      this.#db.run("ALTER TABLE event ADD COLUMN aggregate TEXT NOT NULL DEFAULT 'session'")
    }
    // Event timestamps (client-facing read models — usage heatmap, timelines):
    // the durable shape stays (aggregate_id, seq, type, data); created_at is
    // store-level metadata. Legacy rows keep NULL (honestly excluded from
    // time-based views rather than backfilled with a fake time).
    if (!cols.some((c) => c.name === "created_at")) {
      this.#db.run("ALTER TABLE event ADD COLUMN created_at INTEGER")
    }
    // A legacy DB may also have events without a corresponding `event_sequence`
    // row (the allocator predates the sequence table, or the DB was created by an
    // even older build). When the sequence table is empty but events exist, the
    // next incremental seq would collide with an existing event seq. Seed the
    // allocator from each aggregate's current max seq so appends continue past it.
    const seqCount = this.#db.query("SELECT COUNT(*) AS n FROM event_sequence").get() as { n: number } | null
    if ((seqCount?.n ?? 0) === 0) {
      const maxes = this.#db.query("SELECT aggregate_id, MAX(seq) AS max_seq FROM event GROUP BY aggregate_id").all() as { aggregate_id: string; max_seq: number }[]
      for (const m of maxes) {
        this.#db.run("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?) ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq", [m.aggregate_id, m.max_seq])
      }
    }
  }

  async append<T extends UnknownRecord>(aggregate_id: string, type: string, data: T, aggregate: AggregateType = "session"): Promise<StoredEvent> {
    const seq = this.#nextSeq(aggregate_id)
    this.#db.run("INSERT INTO event (aggregate_id, seq, type, data, aggregate, created_at) VALUES (?, ?, ?, ?, ?, ?)", [aggregate_id, seq, type, JSON.stringify(data), aggregate, Date.now()])
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

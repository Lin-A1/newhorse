import type { StoredEvent, SessionEvent, UnknownRecord } from "@newhorse/schema"

/**
 * Durable event store. Everything the model can see must live here first.
 *
 * The shape is `(aggregate_id, seq, type, data)` — an append-only log. This is
 * the read/write seam backend; M1 ships a memory implementation, but the
 * contract allows a SQLite/Drizzle backend without touching session logic.
 */
export interface EventStore {
  /** Append an event for an aggregate; returns its assigned sequence. */
  append<T extends UnknownRecord>(aggregate_id: string, type: string, data: T): Promise<StoredEvent>
  /** Read the full ordered event stream for an aggregate. */
  read(aggregate_id: string): Promise<StoredEvent[]>
  /** Latest sequence for an aggregate, or -1 when none. */
  latestSeq(aggregate_id: string): Promise<number>
  /** Distinct aggregate ids known to this store (for inbox/registry hydration). */
  aggregateIds(): Promise<string[]>
}

/** In-memory event store, for tests and the M1 single-process runtime. */
export class MemoryEventStore implements EventStore {
  #events = new Map<string, StoredEvent[]>()

  async append<T extends UnknownRecord>(aggregate_id: string, type: string, data: T): Promise<StoredEvent> {
    const log = this.#events.get(aggregate_id) ?? []
    const seq = log.length
    const event: StoredEvent = { aggregate: "session", aggregate_id, seq, type, data }
    log.push(event)
    this.#events.set(aggregate_id, log)
    return event
  }

  async read(aggregate_id: string): Promise<StoredEvent[]> {
    return this.#events.get(aggregate_id) ?? []
  }

  async latestSeq(aggregate_id: string): Promise<number> {
    return (this.#events.get(aggregate_id)?.length ?? 0) - 1
  }

  async aggregateIds(): Promise<string[]> {
    return [...this.#events.keys()]
  }
}

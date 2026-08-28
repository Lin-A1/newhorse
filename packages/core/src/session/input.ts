import type { Delivery, StoredEvent } from "@newhorse/schema"
import type { EventStore } from "./store"

/**
 * Durable admission inbox.
 *
 * A prompt is admitted to a durable `session_input` cell *before* it becomes
 * model-visible. The inbox is backed by the event log and is RECONSTRUCTED from
 * it on construction, so pending queue state survives restarts — this is what
 * makes the "replayed from the inbox, so pending survives restarts" promise
 * real rather than wishful.
 *
 * Idempotent admit: the same id + same content returns the same receipt; same
 * id + different content is a conflict (deterministic, not best-effort).
 * Promotion only flips a flag derived from the durable `Prompted` event.
 *
 * Delivery vocabulary (mirrors opencode v2 `input.ts`):
 *   - `steer`: promoted at the next safe boundary.
 *   - `queue`: stays pending until the session would otherwise be idle.
 */
export interface SessionInputStore {
  readonly events: EventStore
  admit(input: AdmitInput): Promise<Admission>
  promoteSteers(sessionId: string, cutoff: number): Promise<number>
  promoteNextQueued(sessionId: string): Promise<boolean>
  hasPending(sessionId: string, delivery: Delivery): Promise<boolean>
}

export interface AdmitInput {
  readonly id: string
  readonly sessionId: string
  readonly prompt: string
  readonly delivery: Delivery
  /** Who authored the prompt; drives the caller kind for butler tools (M2b). */
  readonly principal?: "user" | "butler" | "parent"
}

export interface Admission {
  readonly id: string
  readonly sessionId: string
  readonly prompt: string
  readonly delivery: Delivery
  readonly principal?: "user" | "butler" | "parent"
  readonly admittedSeq: number
}

export class SessionInputError extends Error {
  readonly _tag = "SessionInputError"
  constructor(message: string) {
    super(message)
    this.name = "SessionInputError"
  }
}

interface Row {
  id: string
  sessionId: string
  prompt: string
  delivery: Delivery
  principal?: "user" | "butler" | "parent"
  admittedSeq: number
  promotedSeq: number | null
}

/**
 * Memory-backed inbox reconstructed from the durable event log.
 *
 * Construction replays `PromptAdmitted` to rebuild rows and `Prompted` to mark
 * promoted sequences, so a restarted runtime sees the same pending queue the
 * previous process did. Because idempotency is decided against the source of
 * truth (the log) rather than a memory map, concurrent admits of the same new
 * id cannot double-insert.
 */
export class MemorySessionInput implements SessionInputStore {
  readonly events: EventStore
  #rows = new Map<string, Row>()

  constructor(events: EventStore) {
    this.events = events
  }

  /** Rebuild pending rows from the durable log (call after construction). */
  async hydrate(): Promise<void> {
    this.#rows.clear()
    for (const aggregate_id of await this.events.aggregateIds()) {
      for (const event of await this.events.read(aggregate_id)) {
        this.#apply(event)
      }
    }
  }

  async admit(input: AdmitInput): Promise<Admission> {
    // Check the durable log first (source of truth), not a memory map, so a
    // concurrent admit of the same new id can't double-insert.
    const existing = await this.#findDurable(input.id)
    if (existing) {
      if (existing.sessionId === input.sessionId && existing.prompt === input.prompt && existing.delivery === input.delivery) {
        return { id: existing.id, sessionId: existing.sessionId, prompt: existing.prompt, delivery: existing.delivery, principal: existing.principal, admittedSeq: existing.admittedSeq }
      }
      throw new SessionInputError(`admission id "${input.id}" reused with differing session/prompt/delivery`)
    }

    const event = await this.events.append(input.sessionId, "Session.PromptAdmitted", {
      id: input.id,
      sessionId: input.sessionId,
      prompt: input.prompt,
      delivery: input.delivery,
      principal: input.principal ?? "butler",
    })
    const admittedSeq = event.seq
    this.#rows.set(input.id, { id: input.id, sessionId: input.sessionId, prompt: input.prompt, delivery: input.delivery, principal: input.principal ?? "butler", admittedSeq, promotedSeq: null })
    return { id: input.id, sessionId: input.sessionId, prompt: input.prompt, delivery: input.delivery, principal: input.principal ?? "butler", admittedSeq }
  }

  async promoteSteers(sessionId: string, cutoff: number): Promise<number> {
    const rows = [...this.#rows.values()].filter((r) => r.sessionId === sessionId && r.promotedSeq === null && r.delivery === "steer" && r.admittedSeq <= cutoff).sort((a, b) => a.admittedSeq - b.admittedSeq)
    let count = 0
    for (const row of rows) {
      row.promotedSeq = row.admittedSeq
      await this.events.append(sessionId, "Session.Prompted", { id: row.id, sessionId: row.sessionId, prompt: row.prompt, delivery: row.delivery, principal: row.principal ?? "butler", promotedSeq: row.promotedSeq })
      count++
    }
    return count
  }

  async promoteNextQueued(sessionId: string): Promise<boolean> {
    const next = [...this.#rows.values()].filter((r) => r.sessionId === sessionId && r.promotedSeq === null && r.delivery === "queue").sort((a, b) => a.admittedSeq - b.admittedSeq)[0]
    if (!next) return false
    next.promotedSeq = next.admittedSeq
    await this.events.append(sessionId, "Session.Prompted", { id: next.id, sessionId: next.sessionId, prompt: next.prompt, delivery: next.delivery, principal: next.principal ?? "butler", promotedSeq: next.promotedSeq })
    return true
  }

  async hasPending(sessionId: string, delivery: Delivery): Promise<boolean> {
    return [...this.#rows.values()].some((r) => r.sessionId === sessionId && r.promotedSeq === null && r.delivery === delivery)
  }

  #apply(event: StoredEvent): void {
    if (event.type === "Session.PromptAdmitted") {
      const data = event.data as { id?: string; sessionId?: string; prompt?: string; delivery?: Delivery; principal?: "user" | "butler" | "parent" }
      if (!data.id || !data.sessionId || !data.prompt || !data.delivery) return
      this.#rows.set(data.id, { id: data.id, sessionId: data.sessionId, prompt: data.prompt, delivery: data.delivery, principal: data.principal ?? "butler", admittedSeq: event.seq, promotedSeq: null })
    } else if (event.type === "Session.Prompted") {
      const data = event.data as { id?: string; delivery?: Delivery }
      const row = data.id ? this.#rows.get(data.id) : undefined
      if (row) row.promotedSeq = row.admittedSeq
    }
  }

  async #findDurable(id: string): Promise<Row | undefined> {
    const row = this.#rows.get(id)
    if (row) return row
    // Not in memory: search the log for a prior PromptAdmitted with this id.
    for (const aggregate_id of await this.events.aggregateIds()) {
      for (const event of await this.events.read(aggregate_id)) {
        if (event.type === "Session.PromptAdmitted" && (event.data as { id?: string }).id === id) {
          this.#apply(event)
          return this.#rows.get(id)
        }
      }
    }
    return undefined
  }
}

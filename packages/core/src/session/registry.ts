import type { StoredEvent, SessionMessage } from "@newhorse/schema"
import type { EventStore } from "./store"

/**
 * Global session registry: a cross-session index.
 *
 * This is a derived read model (single-writer + materialized projection, CQRS
 * read side). It is built lazily by querying the EventStore — it does NOT hook
 * the store's append path, does NOT broadcast events, and does NOT write its
 * own durable table in M2a. The event log is the only authority; the registry
 * is a reconstructable projection.
 *
 * It is an observational control surface: `list`/`get` return projections and
 * never mutate a session. It exists to give a future butler (M2b) the ability
 * to see and locate sessions, plus the parent chain for auditing send/spawn.
 */
export interface SessionRow {
  readonly sessionId: string
  readonly workspace: string
  readonly projectId?: string
  readonly title?: string
  readonly status: SessionStatus
  readonly model?: string
  readonly parentId?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export type SessionStatus = "created" | "active" | "settled" | "interrupted"

/** A butler action audit row (folded from Session.ButlerAction events). */
export interface AuditRow {
  readonly actorKind: "user" | "butler" | "parent"
  readonly actorId: string
  readonly op: string
  readonly targetSessionId?: string
  readonly outcome: "allowed" | "denied"
  readonly reason?: string
  readonly ts: number
}

export interface RegistryQuery {
  readonly workspace?: string
  readonly status?: SessionStatus
  readonly projectId?: string
}

/**
 * Registry. Lazily folds the EventStore into an in-memory index the first time
 * it is queried; subsequent queries reuse the index. `refresh()` rebuilds the
 * index from the store (or merges new aggregates).
 */
export class SessionRegistry {
  readonly #events: EventStore
  #index = new Map<string, SessionRow>()
  #hydrated = false

  constructor(events: EventStore) {
    this.#events = events
  }

  /** List sessions, optionally filtered. Lazily hydrates the index. */
  async list(query?: RegistryQuery): Promise<SessionRow[]> {
    await this.#ensureHydrated()
    let rows = [...this.#index.values()]
    if (query?.workspace) rows = rows.filter((r) => r.workspace === query.workspace)
    if (query?.status) rows = rows.filter((r) => r.status === query.status)
    if (query?.projectId) rows = rows.filter((r) => r.projectId === query.projectId)
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Get one session row, or undefined if unknown. */
  async get(sessionId: string): Promise<SessionRow | undefined> {
    await this.#ensureHydrated()
    return this.#index.get(sessionId)
  }

  /** Rebuild the index from the store (e.g. after new sessions appear). */
  async refresh(): Promise<void> {
    this.#index.clear()
    await this.#hydrate()
    this.#hydrated = true
  }

  /** Fold butler audit actions for an actor (or all) into a readable list. */
  async audit(actorSessionId?: string): Promise<AuditRow[]> {
    const rows = await this.#events.aggregateIds()
    const out: AuditRow[] = []
    for (const aggregateId of rows) {
      if (!aggregateId.startsWith("audit:")) continue
      if (actorSessionId && aggregateId !== `audit:${actorSessionId}`) continue
      const stored = await this.#events.read(aggregateId)
      out.push(...foldAudit(stored))
    }
    return out.sort((a, b) => b.ts - a.ts)
  }

  async #ensureHydrated(): Promise<void> {
    if (this.#hydrated) return
    await this.#hydrate()
    this.#hydrated = true
  }

  async #hydrate(): Promise<void> {
    for (const aggregateId of await this.#events.aggregateIds()) {
      const stored = await this.#events.read(aggregateId)
      const row = fold(stored)
      if (row) this.#index.set(aggregateId, row)
    }
  }
}

/** Fold a session's event log into a registry row (or undefined if pre-Created). */
export function fold(stored: StoredEvent[]): SessionRow | undefined {
  let sessionId = ""
  let workspace = ""
  let projectId: string | undefined
  let createdAt = 0
  let updatedAt = 0
  let status: SessionStatus = "created"
  let model: string | undefined
  let parentId: string | undefined
  let title: string | undefined
  let hasCreated = false

  for (const event of stored) {
    updatedAt = event.seq
    switch (event.type) {
      case "Session.Created": {
        const d = event.data as { id?: string; location?: string; projectId?: string; createdAt?: number }
        sessionId = d.id ?? ""
        workspace = d.location ?? ""
        projectId = d.projectId
        createdAt = d.createdAt ?? 0
        hasCreated = true
        status = "created"
        break
      }
      case "Session.StepEnded":
        status = "settled"
        break
      case "Session.Interrupted": {
        const d = event.data as { sessionId?: string }
        sessionId = sessionId || d.sessionId || ""
        status = "interrupted"
        break
      }
      case "Session.Spawned": {
        // Record parent chain; does NOT set hasCreated (must pair with Created).
        const d = event.data as { parentId?: string }
        parentId = d.parentId
        break
      }
      case "Session.MessageAppended": {
        const d = event.data as { message?: SessionMessage }
        // Only touch updatedAt; MessageAppended carries no turn boundary, so we
        // never guess "a turn ended" from it.
        if (d.message?.kind === "assistant") {
          if (d.message.model) model = d.message.model
          if (!title) title = excerpt(d.message.content)
        }
        if (status === "created") status = "active"
        break
      }
      default:
        break
    }
  }

  if (!hasCreated) return undefined
  return { sessionId: sessionId || workspace, workspace, projectId, title, status, model, parentId, createdAt, updatedAt }
}

function excerpt(content: readonly unknown[]): string {
  const firstText = content.find((p) => (p as { type?: string }).type === "text")
  const text = (firstText as { text?: string } | undefined)?.text ?? ""
  return text.length > 80 ? text.slice(0, 80) + "…" : text
}

/** Fold a butler-audit aggregate's events into audit rows. */
export function foldAudit(stored: StoredEvent[]): AuditRow[] {
  const out: AuditRow[] = []
  for (const event of stored) {
    if (event.type !== "Session.ButlerAction") continue
    const d = event.data as { actorKind?: "user" | "butler" | "parent"; actorId?: string; op?: string; targetSessionId?: string; outcome?: "allowed" | "denied"; reason?: string; ts?: number }
    if (!d.actorKind || !d.actorId || !d.op || !d.outcome) continue
    out.push({ actorKind: d.actorKind, actorId: d.actorId, op: d.op, targetSessionId: d.targetSessionId, outcome: d.outcome, reason: d.reason, ts: d.ts ?? 0 })
  }
  return out
}

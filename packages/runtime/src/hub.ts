import type { EventStore } from "@newhorse/core"

/**
 * Lightweight multi-session hub (M2b). Tracks a set of runnable sessions within
 * a single app/process and exposes the effects a butler's privileged tools need:
 * interrupt a target, send a prompt to a target, spawn a child. This is the
 * "same-app session tree" the authority model scopes to (see
 * specs/v2/m2b-butler-authority.md §3.3).
 */
/** Result of a hub effect — distinguishes "authorized & scheduled" from "actually
 * applied". In the single-app boundary only spawn is applied; interrupt/send are
 * stubs until a full SessionManager exists (M4). */
export interface HubResult {
  readonly implemented: boolean
  readonly pending?: boolean
  readonly sessionId?: string
}

export interface SessionHub {
  /** Interrupt a target session's running prompt. */
  interrupt(sessionId: string): Promise<HubResult>
  /** Send a prompt into a target session's inbox. */
  send(sessionId: string, content: string): Promise<HubResult>
  /** Spawn a child session; returns the new session id. */
  spawn(parentId: string, model?: string): Promise<string>
}

/** In-memory hub over a shared event store. Sessions are created lazily. */
export function createSessionHub(events: EventStore, open: (sessionId: string) => { interrupt(): void; prompt: (text: string) => Promise<unknown> }): SessionHub {
  const sessions = new Set<string>()
  return {
    async interrupt(sessionId: string) {
      sessions.delete(sessionId)
      void sessionId
      void events
      // Stub until a full SessionManager (M4): reports "not implemented" rather
      // than pretending the target was cancelled.
      return { implemented: false, pending: true, sessionId }
    },
    async send(sessionId: string, _content: string) {
      void open
      // Stub until a full SessionManager (M4).
      return { implemented: false, pending: true, sessionId }
    },
    async spawn(parentId: string, model?: string) {
      const id = crypto.randomUUID()
      await events.append(id, "Session.Created", { id, location: "", createdAt: Date.now() })
      await events.append(id, "Session.Spawned", { sessionId: id, parentId })
      void model
      sessions.add(id)
      return id
    },
  }
}

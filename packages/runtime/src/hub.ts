import type { EventStore } from "@newhorse/core"

/**
 * Lightweight multi-session hub (M2b). Tracks a set of runnable sessions within
 * a single app/process and exposes the effects a butler's privileged tools need:
 * interrupt a target, send a prompt to a target, spawn a child. This is the
 * "same-app session tree" the authority model scopes to (see
 * specs/v2/m2b-butler-authority.md §3.3).
 */
export interface SessionHub {
  /** Interrupt a target session's running prompt (no-op if idle/absent). */
  interrupt(sessionId: string): Promise<void>
  /** Send a prompt into a target session's inbox. */
  send(sessionId: string, content: string): Promise<void>
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
      // A real hub would hold a live app per session and call its interrupt().
      // In the single-app boundary the butler runs in-process; this is the seam
      // a full SessionManager (later) populates. For now no-op (self-interrupt
      // is handled by app.interrupt()).
    },
    async send(_sessionId: string, _content: string) {
      void open
      // In-process: a real hub would route to the target app's inbox.
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

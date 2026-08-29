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
  spawn(parentId: string, model?: string, prompt?: string, agentName?: string): Promise<string>
}

/**
 * A pluggable child driver: when provided, spawn actually RUNS the child
 * (created → driven → settles) instead of leaving a dead row. The caller owns
 * the runtime/tools; this keeps the hub a thin surface and the seam open for a
 * future cross-process SessionManager.
 */
export type ChildDriver = (childId: string, parentId: string, parentWorkspace: string, model?: string, prompt?: string, agentName?: string) => Promise<void>

/** In-memory hub over a shared event store. Sessions are created lazily. */
export function createSessionHub(events: EventStore, open: (sessionId: string) => { interrupt(): void; prompt: (text: string) => Promise<unknown> }, workspace?: string, driver?: ChildDriver): SessionHub {
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
    async spawn(parentId: string, model?: string, prompt?: string, agentName?: string) {
      const id = crypto.randomUUID()
      // A spawned child inherits the parent's workspace (location is the
      // session's project root, driving AGENTS.md discovery + tool sandbox).
      // `workspace` comes from the holder (createSessionHub caller); it must
      // NEVER be blank — fall back to the process cwd so a child created
      // without an explicit workspace is not a "no project" orphan.
      const childWorkspace = workspace ?? process.cwd()
      await events.append(id, "Session.Created", { id, location: childWorkspace, createdAt: Date.now() })
      await events.append(id, "Session.Spawned", { sessionId: id, parentId })
      sessions.add(id)
      // Pluggable driver: when supplied, the child is actually RUN (not a dead
      // row) with the task prompt. Fire-and-forget — the driver owns
      // settlement + promotion. Never let a driver rejection become an
      // unhandled rejection (a failed child must still get a durable Settled).
      if (driver) {
        void driver(id, parentId, childWorkspace, model, prompt, agentName).catch(async (err: unknown) => {
          void err
          // A driver that fails BEFORE writing Settled leaves a zombie; the
          // app-provided driver catches its own errors (and writes Settled),
          // but a foreign driver may not. Only write the terminal marker when
          // one is absent — never double-settle an already-failed child.
          const log = await events.read(id)
          if (!log.some((e) => e.type === "Session.Settled")) {
            await events.append(id, "Session.Settled", { sessionId: id, finish: "error", needsContinuation: false })
          }
        })
      }
      return id
    },
  }
}

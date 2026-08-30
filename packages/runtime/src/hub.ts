import type { EventStore, SessionInputStore } from "@newhorse/core"

/**
 * Lightweight multi-session hub (M2b) with a PROCESS-LOCAL SessionManager
 * (M4 base). Tracks every runnable session in the app/process and exposes the
 * effects the butler's privileged tools need: interrupt a target, send a
 * prompt to a target, spawn a child. This is the "same-app session tree" the
 * authority model scopes to (see specs/v2/m2b-butler-authority.md §3.3).
 *
 * interrupt/send are REAL now: a session is registered (by app.prompt and by
 * the child driver) with its AbortController + inbox, so interrupt() aborts
 * and send() admits a steer. A session that was never registered (e.g. a
 * cold child before its driver starts) reports `implemented:false` — the
 * honest "not yet live" signal, never a fake success.
 */
export interface HubResult {
  readonly implemented: boolean
  readonly pending?: boolean
  readonly sessionId?: string
}

export type RegisterHandle = {
  /** Abort the live run (interrupt). */
  abort: () => void
  /** Admit a steer to this session's inbox (send). */
  admit: (content: string) => Promise<void>
}

export interface SessionHub {
  /** Register a live session (app.prompt / child driver) so interrupt/send can
   *  reach it. Returns an unregister. */
  register(sessionId: string, handle: RegisterHandle): () => void
  /** Interrupt a target session's running prompt. */
  interrupt(sessionId: string): Promise<HubResult>
  /** Send a prompt into a target session's inbox (steer). */
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
export type ChildDriver = (childId: string, parentId: string, parentWorkspace: string, model?: string, prompt?: string, agentName?: string, registerLive?: (abort: () => void, admit: (text: string) => Promise<void>) => () => void) => Promise<void>

/** In-memory hub over a shared event store. Sessions are created lazily. */
export function createSessionHub(events: EventStore, _open: (sessionId: string) => { interrupt(): void; prompt: (text: string) => Promise<unknown> }, workspace?: string, driver?: ChildDriver): SessionHub {
  const sessions = new Set<string>()
  const live = new Map<string, RegisterHandle>()
  /** Register a live session handle; returns an identity-guarded unregister. */
  const doRegister = (sessionId: string, handle: RegisterHandle): (() => void) => {
    live.set(sessionId, handle)
    return () => {
      if (live.get(sessionId) === handle) live.delete(sessionId)
    }
  }
  return {
    register: doRegister,
    async interrupt(sessionId: string) {
      const h = live.get(sessionId)
      if (!h) {
        // Not live (or already settled) — report honestly, not a fake success.
        return { implemented: false, pending: true, sessionId }
      }
      sessions.delete(sessionId)
      h.abort()
      return { implemented: true, sessionId }
    },
    async send(sessionId: string, content: string) {
      const h = live.get(sessionId)
      if (!h) return { implemented: false, pending: true, sessionId }
      await h.admit(content)
      return { implemented: true, sessionId }
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
      // settlement + promotion. `prompt` is the spawner's task instruction;
      // `agentName` selects a role-overlay definition (Phase 4).
      if (driver) {
        // Pass the hub's register to the driver so it can register LIVE child
        // sessions (a butler can interrupt/send its own children, M4). The
        // driver calls registerLive with a child's abort/admit.
        void driver(id, parentId, childWorkspace, model, prompt, agentName, (childAbort, childAdmit) => doRegister(id, { abort: childAbort, admit: childAdmit })).catch(async (err: unknown) => {
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

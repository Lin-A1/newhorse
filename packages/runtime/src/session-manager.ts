import { Session, runSession, type Agent, type EventStore, type MemorySessionInput, type Tool, type ToolCtx, type TurnRuntime } from "@newhorse/core"
import { defaultContextProvider, ensureSystemContext, type SessionContextProvider } from "./context"

/** Idempotency marker owned by the role-body injection (see driveChildSession
 *  — the marker is written by THIS module, never trusted from the caller). */
const ROLE_MARKER = "@newhorse-agent-role"

/**
 * Shared child-session driver (Phase 3): the ONE code path that creates and
 * RUNS a child aggregate — used by the DAG dispatcher and (via the hub) by
 * `spawn_agent`. Without this, spawned children were dead rows.
 *
 * Flow (durable-first, "model-visible ⟺ logged"):
 *   1. Session.Created (location = workspace, never blank)
 *   2. ensureSystemContext — AGENTS.md/Workdir as a first-turn system message
 *   3. inbox.admit (steer) — the child's prompt
 *   4. runSession — the actual turn loop, to settlement
 * Returns the run result + the child's final assistant text (for promotion).
 */

export interface DriveChildOptions {
  readonly runtime: TurnRuntime
  readonly inbox: MemorySessionInput
  readonly events: EventStore
  readonly sessionId: string
  readonly workspace: string
  readonly agent: Agent
  readonly tools: readonly Tool[]
  readonly prompt: string
  /** The real parent session id — threaded into the child's tool ctx caller so
   *  spawned-child tools resolve the true lineage (a default of "parent" would
   *  break grandchild spawn + send/interrupt scoping). */
  readonly parentId: string
  /** Role-overlay body (agent definition) appended after the workspace system
   *  context in the child's first-turn system message. Optional. */
  readonly systemExtra?: string
  /** Optional live-registration hook (M4 session manager): a parent hub can
   *  register the child's AbortController so it can interrupt/send the child
   *  while it runs. The child's controller is created here; on invocation the
   *  driver wraps it with an admit for the inbox. */
  readonly registerLive?: (abort: () => void, admit: (text: string) => Promise<void>) => () => void
  /** Tool-ctx for the child run (e.g. a workspace execpolicy so fs tools can
   *  act — a DAG node must keep its hands). Pass undefined for deny-all. */
  readonly toolCtx?: Omit<ToolCtx, "caller">
  readonly signal?: AbortSignal
  readonly contextProvider?: SessionContextProvider
}

export interface DriveChildResult {
  readonly sessionId: string
  readonly finish: "tool" | "stop" | "length" | "content-filter" | "interrupted" | "error"
  readonly settled: boolean
  /** The child's final assistant text (its answer), for result promotion. */
  readonly text: string
}

/** Create + run a child to settlement. Returns the result (never throws for an
 *  interrupted run — finish="interrupted" is data, like the loop itself). */
export async function driveChildSession(opts: DriveChildOptions): Promise<DriveChildResult> {
  const { events, inbox, sessionId, workspace, contextProvider } = opts
  const provider = contextProvider ?? defaultContextProvider
  // Idempotent creation: hub.spawn may already have written Session.Created +
  // Session.Spawned; only admit the context/prompt for a genuinely fresh child.
  if (!(await events.read(sessionId)).some((e) => e.type === "Session.Created")) {
    await events.append(sessionId, "Session.Created", { id: sessionId, location: workspace, createdAt: Date.now() })
  }
  await ensureSystemContext(events, sessionId, workspace, provider)
  // Role overlay body: a second system message carrying the agent's specialist
  // instructions, appended once (durable, never overwrites the workspace
  // context). The idempotency marker is OWNED here (not the caller's prefix),
  // so a future caller passing a bare body cannot double-append on re-drive.
  if (opts.systemExtra) {
    const log = await events.read(sessionId)
    const already = log.some((e) => e.type === "Session.MessageAppended" && (e.data as { message?: { text?: string } }).message?.text?.startsWith(ROLE_MARKER))
    if (!already) {
      const session = Session.replay(log)
      const sysMsg = session.projectMessage({ kind: "system", id: crypto.randomUUID(), seq: 0, text: `${ROLE_MARKER}\n${opts.systemExtra}` })
      await events.append(sessionId, sysMsg.type, sysMsg.data as Record<string, unknown>)
    }
  }
  await inbox.admit({ id: crypto.randomUUID(), sessionId, prompt: opts.prompt, delivery: "steer" })
  // Live registration (M4 session manager): the child's AbortController is
  // created here so a parent hub can interrupt it mid-run; the admit wraps the
  // child's own inbox. Unregistered on settle (finally).
  const childCtrl = new AbortController()
  const unregisterLive = opts.registerLive
    ? opts.registerLive(
        () => childCtrl.abort(),
        (text) => inbox.admit({ id: crypto.randomUUID(), sessionId, prompt: text, delivery: "steer", principal: "parent" }).then(() => {}),
      )
    : undefined
  let result
  try {
    result = await runSession(opts.runtime, {
      sessionId,
      agent: opts.agent,
      resolveTool: (name) => opts.tools.find((t) => t.name === name),
      signal: opts.signal ?? childCtrl.signal,
      caller: { kind: "parent", sessionId: opts.parentId },
      toolCtx: opts.toolCtx,
    })
    return {
      sessionId,
      finish: result.finish,
      settled: result.finish !== "interrupted",
      text: await readChildText(events, sessionId),
    }
  } finally {
    unregisterLive?.()
  }
}

/** Read a child's assistant text from its durable log. */
export async function readChildText(events: EventStore, sessionId: string): Promise<string> {
  const log = await events.read(sessionId)
  const parts: string[] = []
  for (const e of log) {
    if (e.type !== "Session.MessageAppended") continue
    const m = (e.data as { message?: { kind?: string; content?: { type?: string; text?: string }[] } }).message
    if (m?.kind !== "assistant") continue
    for (const p of m.content ?? []) {
      if (p.type === "text" && p.text) parts.push(p.text)
    }
  }
  return parts.join("\n")
}

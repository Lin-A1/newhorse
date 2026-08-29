import { runSession, type Agent, type EventStore, type MemorySessionInput, type Tool, type ToolCtx, type TurnRuntime } from "@newhorse/core"
import { defaultContextProvider, ensureSystemContext, type SessionContextProvider } from "./context"

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
  await events.append(sessionId, "Session.Created", { id: sessionId, location: workspace, createdAt: Date.now() })
  await ensureSystemContext(events, sessionId, workspace, provider)
  await inbox.admit({ id: crypto.randomUUID(), sessionId, prompt: opts.prompt, delivery: "steer" })
  const result = await runSession(opts.runtime, {
    sessionId,
    agent: opts.agent,
    resolveTool: (name) => opts.tools.find((t) => t.name === name),
    signal: opts.signal,
    caller: { kind: "parent", sessionId: "parent" },
    toolCtx: opts.toolCtx,
  })
  return {
    sessionId,
    finish: result.finish,
    settled: result.finish !== "interrupted",
    text: await readChildText(events, sessionId),
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

import { MemoryEventStore, MemorySessionInput, Session, SqliteEventStore, SessionRegistry, runSession, discoverWorkspaceContext, composeSystemContext, stableSessionId, type Agent, type TurnRuntime, type Tool, type EventStore, type LoopEvent, type SessionRow, type RegistryQuery, type AuditEventRow, type Initiator } from "@newhorse/core"
import { join, dirname } from "node:path"
import { mkdir } from "node:fs/promises"
import { makeLlmClient, type AdapterConfig, type Fetcher } from "@newhorse/llm"
import { PluginRegistry, discoverPlugin } from "@newhorse/plugin"
import { createButlerTools } from "./butler"
import { createSessionHub } from "./hub"
import { createBuiltinTools, createExecPolicy, rulesFilePath } from "./tools"
import type { ExecPolicy, ExecRule, ApprovalRequest } from "@newhorse/schema"

/**
 * Runtime assembly. This is the domain wiring shared by every transport
 * (CLI / web / desktop / SDK). It composes the seams into a runnable agent
 * session and exposes how the model-visible view is produced. It holds NO
 * transport concerns — no stdin/stdout, no WebSocket, no UI. A shell imports
 * `createApp`, drives `prompt`, and renders `events`/the returned history.
 */
export interface AppConfig {
  readonly provider: AdapterConfig
  readonly model: string
  readonly sessionId?: string
  readonly workspace?: string
  /** A plugin registry whose tools back the agent. Optional. */
  readonly plugins?: PluginRegistry
  /** A plugin directory to discover by convention (tools/agents/commands/
   * hooks). Discovered capabilities are registered into `plugins` (or a fresh
   * registry). M1 consumes only `tool` capabilities into the build; the other
   * kinds register through the same seam so a later milestone can wire them
   * without rework. Optional. */
  readonly pluginsDir?: string
  /** Direct tool list override (for tests or embedding). Optional. */
  readonly tools?: readonly Tool[]
  /** Data dir to persist the event store across restarts. */
  readonly dataDir?: string
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  readonly fetch?: Fetcher
  /** Enable the butler toolset (list/send/spawn/interrupt) for this session. */
  readonly asButler?: boolean
  /** Expose the shell `bash` tool. Off by default because it is not sandboxed
   * to the workspace (M3.5 §2.2): enabling it authorizes the session to
   * read/write/execute any reachable path with the process user's permissions. */
  readonly enableBash?: boolean
  /** M4 execpolicy: user-declared rules (allow/prompt/forbid). Optional; empty
   * rules + the built-in dangerous floor still apply (fail-closed). */
  readonly execRules?: readonly ExecRule[]
  /** M4 execpolicy: interactive approval gate injected by the transport. When
   * absent, a `prompt` resolves to `forbid` (fail-closed). */
  readonly onApprove?: (req: ApprovalRequest) => Promise<boolean>
}

/** A live session event a shell may observe (streamed model output, etc.). */
export type AppEvent = LoopEvent

export interface App {
  readonly sessionId: string
  readonly events: EventStore
  /** Subscribe to live session events; returns an unsubscribe function. */
  readonly onEvent: (listener: (event: AppEvent) => void) => () => void
  /**
   * Run one prompt through admission → turn → settlement.
   * `principal` marks who authored the prompt (user from a human TTY, else
   * butler/parent); it drives the caller kind for butler tools (M2b).
   */
  readonly prompt: (text: string, principal?: "user" | "butler" | "parent") => Promise<PromptResult>
  /** Reconstruct the current session projection from the log. */
  readonly resume: () => Promise<Session>
  /** Query the session registry (observational control surface). */
  readonly listSessions: (query?: RegistryQuery) => Promise<SessionRow[]>
  /** Fold butler audit actions into a readable list. */
  readonly audit: (actorSessionId?: string) => Promise<AuditEventRow[]>
  /** Interrupt the running session (single-process cancel). */
  readonly interrupt: () => void
  /** Steer the running drain: admit a prompt that is promoted at the next safe
   * boundary of the in-flight run (no-op if the session is idle). */
  readonly steer: (text: string) => Promise<void>
}

/** Structured outcome of a prompt run (a shell renders this, not a string). */
export interface PromptResult {
  readonly step: number
  readonly needsContinuation: boolean
  readonly finish: "tool" | "stop" | "length" | "content-filter" | "interrupted" | "error"
}

export async function createApp(config: AppConfig): Promise<App> {
  if (config.sessionId !== undefined && config.sessionId.trim() === "") {
    throw new Error("sessionId must be a non-empty string")
  }
  const events = await createStore(config.dataDir)
  const inbox = new MemorySessionInput(events)
  await inbox.hydrate()

  const llm = makeLlmClient(config.provider, config.fetch)
  const runtime: TurnRuntime = { events, inbox, llm }

  const sessionId = config.sessionId ?? stableSessionId(config.workspace ?? process.cwd())
  const existing = await events.read(sessionId)
  if (existing.length === 0) {
    await events.append(sessionId, "Session.Created", { id: sessionId, location: config.workspace ?? process.cwd(), createdAt: Date.now() })
  }

  const registry = new SessionRegistry(events)
  // Priority (M3.5 §2.3): builtin is the baseline; plugin tools and an explicit
  // `tools` override are ADDITIVE, never a replacement that silently drops
  // read/write/edit. An explicit empty array is a deliberate "no extra tools",
  // not a request to lose the fs hands.
  const workspace = config.workspace ?? process.cwd()
  const builtin = createBuiltinTools({ workspace, enableBash: config.enableBash ?? false })
  // Discover a plugin directory (directory-as-registration-surface) and register
  // its capabilities into a PluginRegistry, so a pluginsDir yields tools (and
  // agents/commands/hooks) by convention rather than requiring the caller to
  // assemble a registry by hand.
  let pluginRegistry = config.plugins
  if (config.pluginsDir) {
    pluginRegistry ??= new PluginRegistry()
    const caps = await discoverPlugin(config.pluginsDir)
    if (caps.length > 0) pluginRegistry.registerDiscovered(caps)
  }
  const pluginTools = pluginRegistry?.list("tool").map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: t.execute })) ?? []
  const explicitTools = config.tools ?? []
  // Order: explicit (highest priority, first in the map so resolve prefers it),
  // then plugin, then builtin baseline.
  const tools: Tool[] = [...explicitTools, ...pluginTools, ...builtin]

  // Butler toolset (M2b): a signed set of privileged tools whose execute reads
  // ctx.caller + ctx.registry to authorize and audit each action.
  const appendAudit = async (entry: { actorKind: "user" | "butler" | "parent"; actorId: string; op: string; targetSessionId?: string; outcome: "allowed" | "denied"; reason?: string }): Promise<void> => {
    await events.append(`audit:${sessionId}`, "Session.ButlerAction", {
      sessionId,
      actorKind: entry.actorKind,
      actorId: entry.actorId,
      op: entry.op,
      targetSessionId: entry.targetSessionId,
      outcome: entry.outcome,
      reason: entry.reason,
      ts: Date.now(),
    })
  }
  if (config.asButler) tools.push(...createButlerTools({ registry, appendAudit }))
  const hub = config.asButler ? createSessionHub(events, () => ({ interrupt: () => {}, prompt: async () => "" })) : undefined

  // First occurrence wins so precedence (explicit > plugin > builtin) is
  // preserved: a later duplicate with the same name never shadows a higher-
  // priority tool. `new Map` alone would make the LAST entry win, inverting
  // the order we built `tools` in.
  const toolMap = new Map()
  for (const t of tools) if (!toolMap.has(t.name)) toolMap.set(t.name, t)
  // The model must not see duplicate function names (conflicting schemas across
  // the explicit/plugin/builtin copies). Resolve the agent's tool list from the
  // deduped map so execution precedence and the protocol surface agree.
  const agentTools = [...toolMap.values()]
  const agent: Agent = { id: "primary", model: config.model, tools: agentTools }

  // M4 execpolicy: the tool-layer authorization axis. For a session with no
  // onApprove gate (DAG child / non-interactive SDK), a `prompt` resolves to
  // forbid (fail-closed). The rules engine loads/reboots from dataDir; without a
  // dataDir the policy still applies the built-in danger floor.
  const execAudit = async (entry: { kind: "command" | "path"; action: string; decision: "prompt" | "forbid"; reason?: string; requestId?: string }): Promise<void> => {
    await events.append(`audit:${sessionId}`, "Session.ExecDecision", {
      sessionId,
      kind: entry.kind,
      action: entry.action,
      decision: entry.decision,
      reason: entry.reason,
      requestId: entry.requestId,
      ts: Date.now(),
    })
  }
  const rulesFile = config.dataDir ? rulesFilePath(config.dataDir, workspace) : join(process.cwd(), "..", "..", ".execpolicy-rules.json")
  const execPolicy: ExecPolicy = createExecPolicy({
    rulesFile,
    rules: config.execRules,
    // rulesDir must point at the rules file's own directory (the host-owned
    // location), never the workspace — otherwise every absolute workspace path
    // passed to decidePath would trip the banned-rules-path check. With no
    // dataDir the rules file is a shared sibling location (non-embedded use
    // always passes dataDir; the no-dataDir branch is a fallback).
    rulesDir: dirname(rulesFile),
    onApprove: config.onApprove,
    audit: execAudit,
  })

  // Live event fan-out. The prompt run emits streamed model/tool events through
  // a small hook so a shell can render incrementally without polling the log.
  // Each listener is isolated: a throwing/slow listener must not corrupt the
  // turn loop's settlement path.
  const listeners = new Set<(event: AppEvent) => void>()
  const emit = (event: AppEvent): void => {
    for (const l of listeners) {
      try {
        l(event)
      } catch {
        // A broken listener must never sink the run.
      }
    }
  }
  const onEvent = (listener: (event: AppEvent) => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  let current: AbortController | undefined

  const app: App = {
    sessionId,
    events,
    onEvent,
    async prompt(text: string, principal?: "user" | "butler" | "parent"): Promise<PromptResult> {
      // Ambient workspace AGENTS.md is a Context Source: discovered from the
      // session location and admitted as model-visible context BEFORE the prompt,
      // per the "model-visible ⟺ logged" rule. It is appended only once: once a
      // system message is already in the log we reuse it, so repeated prompts in
      // a session do not keep re-inserting the same context.
      const session = Session.replay(await events.read(sessionId))
      if (!session.messages.some((m) => m.kind === "system")) {
        const docs = await discoverWorkspaceContext(workspace)
        const docsCtx = composeSystemContext(docs)
        // Make the workspace root model-visible so the first-turn model can
        // address files by path instead of guessing (M3.5 §2.4). This leaks the
        // session's working directory, which is the same as every fs tool's
        // scope, so it is not a new disclosure.
        const rootLine = `Workdir: ${workspace}` + (docsCtx ? "\n\n" : "")
        const system = docsCtx ? rootLine + docsCtx : rootLine
        if (system) {
          const systemMessage = session.projectMessage({ kind: "system", id: crypto.randomUUID(), seq: 0, text: system })
          await events.append(sessionId, systemMessage.type, systemMessage.data as Record<string, unknown>)
        }
      }
      const effPrincipal = principal ?? (config.asButler ? "butler" : "parent")
      await inbox.admit({ id: crypto.randomUUID(), sessionId, prompt: text, delivery: "steer", principal: effPrincipal })

      // A fresh abort controller per prompt, so interrupt() cancels only this
      // run and a later prompt is unaffected (an AbortSignal cannot be reset).
      const ctrl = new AbortController()
      current = ctrl
      const caller: Initiator = effPrincipal === "user" ? { kind: "user" } : config.asButler ? { kind: "butler", sessionId } : { kind: "parent", sessionId }
      try {
        const result = await runSession(runtime, {
          agent,
          sessionId,
          resolveTool: (name) => toolMap.get(name),
          onEvent: emit,
          signal: ctrl.signal,
          caller,
          toolCtx: hub ? { registry, appendAudit, interruptTarget: hub.interrupt, sendToTarget: hub.send, spawnFrom: hub.spawn, execPolicy } : { registry, appendAudit, execPolicy },
        })
        return { step: result.step, needsContinuation: result.needsContinuation, finish: result.finish }
      } finally {
        if (current === ctrl) current = undefined
      }
    },
    async resume(): Promise<Session> {
      return Session.replay(await events.read(sessionId))
    },
    async listSessions(query) {
      await registry.refresh()
      return registry.list(query)
    },
    async audit(actorSessionId) {
      return registry.audit(actorSessionId)
    },
    interrupt() {
      current?.abort()
    },
    async steer(text) {
      // Admitted as a steer: the running drain promotes it at the next safe
      // provider-turn boundary (admission inbox semantics, see specs §2.2).
      await inbox.admit({ id: crypto.randomUUID(), sessionId, prompt: text, delivery: "steer", principal: "user" })
    },
  }

  return app
}

async function createStore(dataDir?: string): Promise<EventStore> {
  // Long-horizon work requires durable state: when a dataDir is given we back
  // the event log with SQLite so a restart reconstructs the session + pending
  // inbox from disk (see specs §2). Without a dataDir we fall back to memory.
  if (dataDir) {
    // Ensure the dir exists and surface a mkdir failure clearly rather than
    // letting SqliteEventStore.open crash with an opaque path error.
    await mkdir(dataDir, { recursive: true })
    try {
      await Bun.write(join(dataDir, ".keep"), "")
    } catch (e) {
      throw new Error(`cannot persist session state to "${dataDir}": ${e instanceof Error ? e.message : String(e)}`)
    }
    return SqliteEventStore.open(join(dataDir, "events.db"))
  }
  return new MemoryEventStore()
}

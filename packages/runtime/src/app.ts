import { MemoryEventStore, MemorySessionInput, Session, SqliteEventStore, SessionRegistry, runSession, stableSessionId, type Agent, type TurnRuntime, type Tool, type EventStore, type LoopEvent, type SessionRow, type RegistryQuery, type AuditEventRow, type Initiator } from "@newhorse/core"
import { join, dirname } from "node:path"
import { mkdir } from "node:fs/promises"
import { makeLlmClient, type AdapterConfig, type Fetcher } from "@newhorse/llm"
import { PluginRegistry, discoverPlugin } from "@newhorse/plugin"
import type { MemoryStore } from "@newhorse/memory"
import { createButlerTools } from "./butler"
import { createSessionHub } from "./hub"
import { driveChildSession, readChildText } from "./session-manager"
import { resolveAgent, type AgentDefinition } from "./agent-resolver"
import { createBuiltinTools, createExecPolicy, rulesFilePath } from "./tools"
import { defaultContextProvider, ensureSystemContext, type SessionContextProvider } from "./context"
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
  /**
   * Memory seam (Phase 4 reserve): when supplied, the memory tools
   * (memory_search / memory_write) are exposed. Absent = no memory tools.
   * (Session.MemoryStored is reserved in schema but NOT emitted yet — the
   * write path currently archives tool results as ordinary tool messages.)
   */
  readonly memoryStore?: MemoryStore
  /**
   * Workspace context provider (pluggable seam). Default = AGENTS.md discovery
   * + compose (with the Workdir line). A caller can inject a custom provider to
   * override the ambient context (e.g. a narrower scope for a child session).
   */
  readonly contextProvider?: SessionContextProvider
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
  // Priority (M3.5 §2.3): semantics are discriminated on `!== undefined`, not
  // truthiness. `config.tools === undefined` -> assemble the default baseline
  // (plugin + builtin, plugin wins name collisions). A provided array is an
  // EXPLICIT override: non-empty -> explicit > plugin > builtin (additive, first
  // occurrence wins a name collision); an explicit empty array is the deliberate
  // signifier "no tools" (the toolset is override-to-zero, not "keep read/write/
  // edit"). Tools are pluggable, so an override can be re-plugged later.
  const workspace = config.workspace ?? process.cwd()
  const contextProvider: SessionContextProvider = config.contextProvider ?? defaultContextProvider
  const builtin = createBuiltinTools({ workspace, enableBash: config.enableBash ?? false, memoryStore: config.memoryStore })
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
  // An explicitly-provided empty array is the override-to-zero signifier.
  const tools: Tool[] = config.tools?.length === 0
    ? []
    : [...explicitTools, ...pluginTools, ...builtin]

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

  // Agent definitions (Phase 4): pulled from the plugin seam (list("agent")) —
  // name -> definition, consumed by DAG nodes and butler spawn via resolveAgent.
  const agentDefinitions: Record<string, AgentDefinition> = {}
  for (const cap of pluginRegistry?.list("agent") ?? []) {
    agentDefinitions[cap.name] = { name: cap.name, description: cap.description, body: cap.body, allowedTools: cap.allowedTools, role: cap.role, model: cap.model }
  }

  // Butler hub (M2b) with a LIVE child driver (Phase 3). spawn now actually
  // RUNS the child (Created → system context → admit → runSession) and, on
  // settle, promotes the child's final text into the PARENT's inbox as a
  // synthetic result so the parent's next turn sees it. Without the driver
  // (non-butler) the hub is undefined.
  const hub = config.asButler
    ? createSessionHub(
        events,
        () => ({ interrupt: () => {}, prompt: async () => "" }),
        workspace,
        async (childId, parentId, childWorkspace, model, prompt, agentName) => {
          // Role overlay (Phase 4): a named agent from the plugin registry
          // narrows tools + supplies a system body; else bare spawned agent.
          // An UNKNOWN agent name fails loudly (a typo must not silently spawn
          // a full-authority child with no body).
          if (agentName && !agentDefinitions[agentName]) {
            throw new Error(`unknown agent "${agentName}" (not registered in the plugin registry)`)
          }
          const agentDef = agentName ? agentDefinitions[agentName] : undefined
          const resolved = resolveAgent(agentDef, { tools: agentTools, model: config.model }, model)
          try {
            const driven = await driveChildSession({
              runtime,
              inbox,
              events,
              sessionId: childId,
              workspace: childWorkspace,
              agent: { id: resolved.id, model: resolved.model, tools: [...resolved.tools] },
              tools: [...resolved.tools],
              prompt: prompt ?? "You are a spawned agent working for your parent. Complete the task.",
              parentId,
              systemExtra: resolved.body,
              contextProvider: config.contextProvider,
            })
            // Durable settle boundary (followup_task reads it) + promote the
            // child's text into the parent's inbox as a steer so the parent's
            // next turn can consume the result (result promotion).
            await events.append(childId, "Session.Settled", { sessionId: childId, finish: driven.finish, needsContinuation: false })
            if (driven.settled) {
              await inbox.admit({ id: crypto.randomUUID(), sessionId: parentId, prompt: `[child ${childId} result]\n${driven.text}`, delivery: "steer", principal: "parent" })
            } else {
              // Interrupted: promote the failure marker so followup_task + the
              // parent see a terminal state, not a forever-"running" zombie.
              await inbox.admit({ id: crypto.randomUUID(), sessionId: parentId, prompt: `[child ${childId} interrupted]\n${driven.text}`, delivery: "steer", principal: "parent" })
            }
          } catch (err) {
            // A rejected driver would otherwise leave the child un-setled
            // (followup_task reports "running" forever) and the parent without
            // any promotion. Surface it as a durable failure on both ends.
            const message = err instanceof Error ? err.message : String(err)
            await events.append(childId, "Session.Settled", { sessionId: childId, finish: "error", needsContinuation: false })
            await inbox.admit({ id: crypto.randomUUID(), sessionId: parentId, prompt: `[child ${childId} failed]\n${message}`, delivery: "steer", principal: "parent" })
          }
        },
      )
    : undefined

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
      await ensureSystemContext(events, sessionId, workspace, contextProvider)
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
          toolCtx: hub ? {
            registry,
            appendAudit,
            interruptTarget: hub.interrupt,
            sendToTarget: hub.send,
            spawnFrom: hub.spawn,
            queryTask: async (taskId) => {
              const log = await events.read(taskId)
              const settled = log.find((e) => e.type === "Session.Settled")
              if (settled) {
                const finish = (settled.data as { finish?: string }).finish
                return { state: "settled", finish, text: await readChildText(events, taskId) }
              }
              return { state: log.some((e) => e.type === "Session.Created") ? "running" : "unknown" }
            },
            execPolicy,
          } : { registry, appendAudit, execPolicy },
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

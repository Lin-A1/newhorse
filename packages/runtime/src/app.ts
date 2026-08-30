import { MemoryEventStore, MemorySessionInput, Session, SqliteEventStore, SessionRegistry, runSession, stableSessionId, type Agent, type TurnRuntime, type Tool, type EventStore, type LoopEvent, type SessionRow, type RegistryQuery, type AuditEventRow, type Initiator, type RunOptions } from "@newhorse/core"
import { join, dirname } from "node:path"
import { mkdir } from "node:fs/promises"
import { makeLlmClient, type AdapterConfig, type Fetcher } from "@newhorse/llm"
import { PluginRegistry, discoverPlugin } from "@newhorse/plugin"
import type { MemoryStore } from "@newhorse/memory"
import { runMemoryExtraction } from "@newhorse/memory"
import { createEmbeddingProvider, type EmbeddingConfig } from "@newhorse/memory"
import { createDefaultMemoryPipeline } from "./memory-pipeline"
import { createButlerTools } from "./butler"
import { createSessionHub } from "./hub"
import { driveChildSession, readChildText } from "./session-manager"
import { resolveAgent, type AgentDefinition } from "./agent-resolver"
import { currentTodos, type TodoItem } from "@newhorse/core"
import { currentGoal, type GoalState } from "@newhorse/core"
import { createBuiltinTools, createExecPolicy, rulesFilePath } from "./tools"
import { allowAllExecPolicy } from "@newhorse/core"
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
  /** Trust switch for EXECUTABLE plugin code (.ts tool definitions). Off by
   *  default — loading third-party code is a trust decision, not a convention.
   *  JSON tool declarations (schema-only stubs) are unaffected. */
  readonly allowPluginCode?: boolean
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
   * Post-turn memory extraction (default pipe): when enabled AND a memoryStore
   * is present, the session's latest user/assistant turns are extracted into
   * durable memories after a prompt settles (fail-closed — a broken LLM is a
   * no-op). The pipe uses the app's own LLM client + model. Default OFF (a
   * LLM call per turn is a real cost; the caller must opt in).
   */
  readonly memoryExtract?: {
    readonly enabled?: boolean
    /**
     * Extraction trigger seam (pluggable): decide whether to extract after
     * this settled prompt. Default: every settled prompt. E.g. everyNth or
     * content-based triggers slot here without touching the pipeline.
     */
    readonly shouldExtract?: (result: { readonly step: number; readonly finish: string }, sessionId: string) => boolean
    /** How many recent user/assistant turns to feed the extractor (default 30). */
    readonly recentCount?: number
  }
  /**
   * Semantic memory (switchable): when enabled AND a memoryStore is present,
   * an EmbeddingProvider is attached to the store — writes embed their content
   * (fail-soft, deferred) and searches fuse BM25 + cosine via RRF. Off (or a
   * broken endpoint) = keyword-only FTS, which is always the floor.
   */
  /**
   * Approval policy (permission level):
   *   strict (default) — execpolicy floor + interactive/deny approval gate;
   *   trusted          — full access: the permission floor never blocks;
   *   readonly         — plan mode: only sideEffects:false tools are exposed.
   */
  readonly approvalPolicy?: "strict" | "trusted" | "readonly"
  readonly memoryVector?: {
    readonly enabled?: boolean
    /** Index behind cosine: auto (sqlite-vec when loadable, else in-memory) | brute | off (legacy scan). */
    readonly mode?: "auto" | "brute" | "off"
    readonly embedding: EmbeddingConfig
  }
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
  /** Run a slash-command line ("/name arg1 arg2") against a plugin command
   * capability (the seam's consumer). Returns the command's output, or undefined
   * when the text is not a registered command. */
  readonly runCommand: (text: string) => Promise<unknown | undefined>
  /** Read the session's current todo list (durable fold — restart-safe). */
  readonly todos: () => Promise<TodoItem[]>
  /** Read the session's current goal + budget state (durable fold). */
  readonly goal: () => Promise<GoalState | null>
  /** Read the session's current approval policy. */
  readonly policy: () => "strict" | "trusted" | "readonly"
  /**
   * Change the approval policy (host/operator action). Durably recorded
   * (Session.PolicyChanged) and effective from the next prompt.
   */
  readonly setPolicy: (policy: "strict" | "trusted" | "readonly") => Promise<void>
}

/** Structured outcome of a prompt run (a shell renders this, not a string). */
export interface PromptResult {
  readonly step: number
  readonly needsContinuation: boolean
  readonly finish: "tool" | "stop" | "length" | "content-filter" | "interrupted" | "error"
}

/**
 * Assemble the plugin registry's hook capabilities into the loop's hook seam.
 * A hook that BLOCKS returns { decision: "block" } (stop can force another
 * step; pre-tool-use can deny a call). Errors from a hook are isolated: a
 * broken hook must never corrupt the settlement path — it behaves as "allow".
 */
function makeHookRunner(pluginRegistry?: PluginRegistry): RunOptions["runHooks"] {
  if (!pluginRegistry) return undefined
  const hooks = pluginRegistry.list("hook")
  if (hooks.length === 0) return undefined
  return async (event, input) => {
    const matching = hooks.filter((h) => h.event === event)
    if (matching.length === 0) return { decision: "allow" }
    for (const h of matching) {
      try {
        const result = await h.run(input)
        // A hook returning a truthy "block"-ish result decides the verdict.
        if (result && typeof result === "object" && (result as { decision?: string }).decision === "block") {
          return { decision: "block", reason: (result as { reason?: string }).reason }
        }
      } catch {
        // Fail-open to allow: a throwing hook is still observable, but must
        // not deny the turn.
      }
    }
    return { decision: "allow" }
  }
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
  // Semantic memory (switchable): attach the embedder BEFORE the toolset so
  // memory writes embed from the first turn; off or a broken endpoint degrades
  // to keyword-only FTS (the always-present floor). Backfill runs in the
  // background (budgeted; idempotent).
  if (config.memoryStore && config.memoryVector?.enabled && config.memoryVector.embedding) {
    const embedder = createEmbeddingProvider(config.memoryVector.embedding)
    // A custom MemoryStore without attachEmbedder cannot do semantic search —
    // warn once instead of crashing createApp on a non-null assertion.
    if (!config.memoryStore.attachEmbedder) {
      console.error("\u001b[33m[memory] memoryVector.enabled but the store does not support attachEmbedder — semantic search off\u001b[0m")
    } else {
      // One-time stderr notice when embedding fails (silent degradation is the
      // failure mode that makes a user believe semantic search is on).
      let warnedEmbedFail = false
      const watched: typeof embedder = {
        dimensions: embedder.dimensions,
        embed: async (text, purpose) => {
          const v = await embedder.embed(text, purpose)
          if (!v && !warnedEmbedFail) {
            warnedEmbedFail = true
            console.error("\u001b[33m[memory] embedding failed — semantic search degraded to keyword-only (check the embedding endpoint/key)\u001b[0m")
          }
          return v
        },
      }
      // Tag = the embedding model so rows from different models never mix.
      const { backfill } = config.memoryStore.attachEmbedder(watched, config.memoryVector.embedding.model, { vectorMode: config.memoryVector.mode ?? "auto" })
      void backfill().catch(() => {})
    }
  }
  // skillsDir = the plugin dir (its `skills/` sub-tree is discovered lazily by
  // the skill tool). The tool is only exposed when a pluginsDir is configured.
  const builtin = createBuiltinTools({ workspace, enableBash: config.enableBash ?? false, memoryStore: config.memoryStore, skillsDir: config.pluginsDir, events })
  // Discover a plugin directory (directory-as-registration-surface) and register
  // its capabilities into a PluginRegistry, so a pluginsDir yields tools (and
  // agents/commands/hooks) by convention rather than requiring the caller to
  // assemble a registry by hand.
  let pluginRegistry = config.plugins
  if (config.pluginsDir) {
    pluginRegistry ??= new PluginRegistry()
    const caps = await discoverPlugin(config.pluginsDir, { trustCode: config.allowPluginCode ?? false })
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
  // Approval policy (permission level): readonly filters the model's tool
  // surface to sideEffects:false tools (declarative — no name blacklists);
  // trusted leaves the surface whole and short-circuits the floor below.
  // Approval policy is DYNAMIC: the host may set it (app.setPolicy) and the
  // model may request a change (request_mode tool) — so the tool surface and
  // the floor are computed per-prompt from currentPolicy, never cached.
  let currentPolicy: "strict" | "trusted" | "readonly" = config.approvalPolicy ?? "strict"
  const applyPolicy = (tools: typeof agentTools, policy: "strict" | "trusted" | "readonly") =>
    policy === "readonly" ? tools.filter((t) => t.sideEffects === false) : tools

  // The LIVE tool surface of the running prompt (mutable in place): when the
  // policy changes mid-drain (request_mode approved), the same array is
  // refilled so the next turn's request sees the widened surface — agent.tools
  // is captured once per drain by the loop, so in-place is the only way.
  let liveSurface: Tool[] = []
  // request_mode: the model's ONLY channel out of readonly/plan mode. It goes
  // through the SAME onApprove gate the transport installed — approval is the
  // host's decision, and only then does the policy actually change.
  const requestModeTool: Tool = {
    name: "request_mode",
    sideEffects: false, // a request, not an execution — the gate decides
    description: "Request a change of the session approval policy (only meaningful in readonly/plan mode). Args: { target: \"strict\" | \"trusted\", reason } — the host approves or denies; on approval the policy changes for subsequent turns.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["strict", "trusted"] },
        reason: { type: "string", description: "Why the plan is complete and execution mode is needed." },
      },
      required: ["target", "reason"],
    },
    execute: async (input: unknown) => {
      const { target, reason } = (input ?? {}) as { target?: string; reason?: string }
      if (target !== "strict" && target !== "trusted") return { error: 'target must be "strict" or "trusted"' }
      if (!reason) return { error: "reason is required" }
      const approved = config.onApprove
        ? await config.onApprove({ id: crypto.randomUUID(), kind: "mode", target, decision: "prompt", reason })
        : false // no gate installed → the host was never asked → deny
      if (!approved) return { requested: target, granted: false, reason: "host denied the mode change" }
      // Inline the policy change (by: "model-approved"): currentPolicy is a
      // closure variable and the durable event records WHO changed it. The
      // live surface is refilled IN PLACE so the next turn's request sees the
      // widened tool set.
      const from = currentPolicy
      currentPolicy = target
      liveSurface.length = 0
      liveSurface.push(...agentTools)
      await events.append(sessionId, "Session.PolicyChanged", { sessionId, from, to: target, by: "model-approved", ts: Date.now() })
      return { requested: target, granted: true, policy: target }
    },
  }
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
        async (childId, parentId, childWorkspace, model, prompt, agentName, registerLive) => {
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
              registerLive,
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
      // Live-session registration (M4 session manager): the butler hub can now
      // interrupt THIS session (abort) and send it a steer (admit) — so
      // `send_to_session`/`interrupt` from another butler tool are REAL.
      const unregisterLive = hub ? hub.register(sessionId, {
        abort: () => ctrl.abort(),
        admit: (text) => inbox.admit({ id: crypto.randomUUID(), sessionId, prompt: text, delivery: "steer", principal: "butler" }).then(() => {}),
      }) : undefined
      const caller: Initiator = effPrincipal === "user" ? { kind: "user" } : config.asButler ? { kind: "butler", sessionId } : { kind: "parent", sessionId }
      try {
        // Per-prompt tool surface from the CURRENT policy (+ request_mode in
        // readonly so the model can ask to leave plan mode).
        liveSurface.length = 0
        liveSurface.push(...applyPolicy(agentTools, currentPolicy), ...(currentPolicy === "readonly" ? [requestModeTool] : []))
        const promptAgent: Agent = { ...agent, tools: liveSurface }
        const result = await runSession(runtime, {
          agent: promptAgent,
          sessionId,
          resolveTool: (name) => liveSurface.find((t) => t.name === name),
          onEvent: emit,
          signal: ctrl.signal,
          caller,
          runHooks: makeHookRunner(pluginRegistry),
          compactSummarize: async (headText) => {
            // The app's own LLM summarizes the folded head (provider-agnostic —
            // any LlmClient). A failure/timeout inside compactSession falls
            // back to the local marker; here we only convert the stream to text.
            const stream = await llm.stream({ model: config.model, messages: [
              { role: "system", content: [{ type: "text", text: "Summarize the conversation head in under 200 words. Capture the objective, decisions made, and current state. Output only the summary." }] },
              { role: "user", content: [{ type: "text", text: headText }] },
            ] })
            let out = ""
            for await (const ev of stream) {
              if (ev.type === "text.delta") out += ev.text
            }
            return out.trim()
          },
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
            execPolicy: currentPolicy === "trusted" ? allowAllExecPolicy : execPolicy,
          } : { registry, appendAudit, execPolicy: currentPolicy === "trusted" ? allowAllExecPolicy : execPolicy },
        })
        // Post-turn memory extraction (opt-in, fire-and-forget): the default
        // pipe uses the app's own LLM client + model; runMemoryExtraction is
        // fail-closed, so a broken LLM is a no-op, never a failed turn.
        const memStore = config.memoryStore
        if (memStore && config.memoryExtract?.enabled) {
          void (async () => {
            try {
              const session = Session.replay(await events.read(sessionId))
              const recent = session.messages
                .filter((m) => m.kind === "user" || m.kind === "assistant")
                .slice(-30)
                .map((m) => ({ role: m.kind === "user" ? "user" : "assistant", text: m.kind === "user" ? (m as { text: string }).text : (m as { content: { type?: string; text?: string }[] }).content.filter((p) => p.type === "text").map((p) => p.text!).join("\n") }))
                .filter((m) => m.text.trim().length > 0)
              if (recent.length > 0 && (!config.memoryExtract?.shouldExtract || config.memoryExtract.shouldExtract({ step: result.step, finish: result.finish }, sessionId))) {
                const pipe = createDefaultMemoryPipeline(llm, config.model)
                const recentCount = config.memoryExtract?.recentCount ?? 30
                await runMemoryExtraction(pipe, memStore, { messages: recent.slice(-recentCount), sessionId })
              }
            } catch (err) {
              void err // best-effort; memory extraction must never poison the turn
            }
          })()
        }
        return { step: result.step, needsContinuation: result.needsContinuation, finish: result.finish }
      } finally {
        unregisterLive?.()
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
    async todos() {
      return currentTodos(await events.read(sessionId))
    },
    async goal() {
      return currentGoal(await events.read(sessionId)) ?? null
    },
    policy() {
      return currentPolicy
    },
    async setPolicy(policy) {
      const from = currentPolicy
      if (from === policy) return
      currentPolicy = policy
      await events.append(sessionId, "Session.PolicyChanged", { sessionId, from, to: policy, by: "host", ts: Date.now() })
    },
    async runCommand(text) {
      // Slash command (transport entry): "/name args". The seam is the plugin
      // registry's command capabilities — never a type branch here.
      const trimmed = text.trim()
      if (!trimmed.startsWith("/")) return undefined
      const space = trimmed.indexOf(" ")
      const name = trimmed.slice(1, space === -1 ? undefined : space).trim()
      const args = (space === -1 ? "" : trimmed.slice(space + 1).trim()).split(/\s+/).filter(Boolean)
      if (!name) return undefined
      const cmd = pluginRegistry?.get("command", name)
      if (!cmd) return undefined
      return cmd.run(args)
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

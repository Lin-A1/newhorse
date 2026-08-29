import { validate, foldDAG, cascadeTerminal, readyNodes, reconcile, DAGError, type DAGSpec, type DAGNode, type Topology, type NodeState } from "@newhorse/core"
import { type Agent, type EventStore, type MemorySessionInput, type Tool, type TurnRuntime, type ToolCtx } from "@newhorse/core"
import { createBuiltinTools, createExecPolicy, simpleHash } from "./tools"
import { driveChildSession } from "./session-manager"
import { defaultContextProvider, type SessionContextProvider } from "./context"
import { join } from "node:path"
import { tmpdir } from "node:os"

/** Max length of a node's output stored in the slot/event (see runNode's
 * agreement comment — the in-memory slot and the persisted event MUST cap at
 * the same value so a crash/resume never changes a downstream node's input). */
const MAX_SLOT_OUTPUT = 64_000

/**
 * Declarative DAG dispatcher (runtime half — drives concurrency).
 *
 * Consumes the core topology/fold primitives and actually runs each DAG node
 * as a subagent session: spawn (persist), admit the node input, run the child
 * via the shared turn loop, write the node's result to a slot store, and wake
 * dependents. Honors per-node models and per-node AbortControllers. Node
 * isolation comes from each node being its own subagent session (its own id,
 * agent, and model) — not a runtime DI scope, which this dispatcher does not
 * need.
 *
 * This is the "declarative, not background-task list" story in action: the
 * graph is an execution spec, ready-queue + event wakeup, no join blocking.
 */
export interface SlotStore {
  readonly set: (dagId: string, nodeId: string, slotId: string, value: { output: string; outputRef: string }) => void
  readonly get: (dagId: string, slotId: string) => { nodeId: string; output: string; outputRef: string; status: "succeeded" } | undefined
}

export function createSlotStore(): SlotStore {
  const slots = new Map<string, Map<string, { nodeId: string; output: string; outputRef: string; status: "succeeded" }>>()
  return {
    set(dagId, nodeId, slotId, value) {
      let s = slots.get(dagId)
      if (!s) {
        s = new Map()
        slots.set(dagId, s)
      }
      s.set(slotId, { nodeId, output: value.output, outputRef: value.outputRef, status: "succeeded" })
    },
    get(dagId, slotId) {
      return slots.get(dagId)?.get(slotId)
    },
  }
}

export interface DagDeps {
  readonly events: EventStore
  readonly inbox: MemorySessionInput
  readonly runtime: TurnRuntime
  /** Tools available to every DAG node. When empty, the builtin toolset (read/
   * write/edit/list/search) is injected so subagent nodes keep their "hands"
   * (M3.5 §2.5). */
  readonly tools: readonly Tool[]
  /** Workspace for builtin tools + child sessions. Defaults to cwd. */
  readonly workspace?: string
  /** Parent model a node inherits when it does not declare its own (cost-down). */
  readonly defaultModel?: string
  /** Cost-down (goal #3): when a node does not declare a model, drop it onto a
   * cheaper model instead of inheriting the parent's. Enabled by flag. */
  readonly costDown?: boolean
  /** Cost-down selection table: role|preset name -> model id. */
  readonly modelPresets?: Readonly<Record<string, string>>
  /** Cost-down fallback model when a node has no role/preset key to look up. */
  readonly cheapModel?: string
  /** Max retry attempts per node on failure. Default 2. */
  readonly maxRetries?: number
  /** Max concurrent nodes. Default 2. */
  readonly concurrency?: number
  /** Optional external abort: aborts the whole graph, stops claiming, aborts in-flight. */
  readonly signal?: AbortSignal
  /** Tool-ctx to pass to each node session (caller is derived per node). When no
   * execPolicy is provided, runDag supplies a default workspace policy so a node
   * can act (goal #3) — the fs tools are sandboxed to the workspace and protect
   * `.newhorse`/`.git`/credentials. Inject one to audit a node like the parent. */
  readonly toolCtx?: Omit<ToolCtx, "caller">
  /**
   * Workspace context provider (pluggable seam). Default = AGENTS.md discovery +
   * compose, so a DAG node inherits the parent's ambient context (location
   * + Workdir). A caller can inject a custom provider to scope a node's context
   * differently — no hardcoded branch.
   */
  readonly contextProvider?: SessionContextProvider
  /**
   * Resume seed (R1): when present, this is not a fresh run — the DAG aggregate
   * already exists. status is initialized from the fold (non-terminal nodes stay
   * running/pending for the pump, terminal ones are respected) and the slot
   * store is rebuilt from NodeResolved outputs. `dagId` is REQUIRED here.
   */
  readonly resume?: { readonly dagId: string }
}

export interface DagOutcome {
  readonly dagId: string
  readonly status: Record<string, NodeState>
  readonly aborted: boolean
  /** Effective model per node that actually started (cost-down visibility
   * across a restart). Nodes that never reached `running` are absent. */
  readonly models: Record<string, string>
}

/** Run a declarative DAG. Returns after all nodes reach a terminal state. */
export async function runDag(spec: DAGSpec, deps: DagDeps): Promise<DagOutcome> {
  const topo = validate(spec)
  // Resume mode: reuse the existing aggregate id (do NOT re-declare); fresh
  // run generates one.
  const dagId = deps.resume?.dagId ?? crypto.randomUUID()
  const isResume = !!deps.resume
  const concurrency = deps.concurrency ?? 2
  // Workspace is the child's project root. Defaults to cwd for convenience
  // (a DAG usually runs in the same process/cwd as its parent); a caller that
  // wants a DIFFERENT workspace must pass it explicitly — never rely on the
  // default when the parent used a custom workspace.
  const workspace = deps.workspace ?? process.cwd()
  const contextProvider: SessionContextProvider = deps.contextProvider ?? defaultContextProvider
  const slotStore = createSlotStore()
  // Subagent nodes need hands: when the caller injects no tools, we default to
  // the builtin toolset so a research/explore node is not limited to bare model
  // answers (M3.5 §2.5 — cost-down is only meaningful if nodes can actually act).
  const tools = deps.tools.length > 0 ? deps.tools : createBuiltinTools({ workspace })

  // DAG nodes must actually be able to ACT (goal #3): cost-down is only
  // meaningful if a cheap-model subagent can read/write inside the workspace.
  // When the caller injects no execpolicy, the turn loop falls back to
  // denyAllExecPolicy (fail-closed) and every builtin fs tool denies — the nodes
  // would have schemas but no hands. Supply a default workspace policy (the same
  // heuristic floor the app applies: workspace fs allowed, `.newhorse`/`.git`
  // /credentials protected) so a node can work without weakening the sandbox.
  // The rules file lives under the OS temp keyed by workspace so the banned-rules
  // path check never points at (and thereby forbids) the workspace itself.
  const dagRulesBase = join(tmpdir(), "newhorse-dag", simpleHash(workspace))
  const nodeToolCtx: Omit<ToolCtx, "caller"> = deps.toolCtx?.execPolicy
    ? deps.toolCtx
    : { ...deps.toolCtx, execPolicy: createExecPolicy({ rulesFile: join(dagRulesBase, "rules.json"), rulesDir: dagRulesBase }) }

  // Resolve every node's effective model up front, so a missing/invalid model is
  // a pre-flight DAGError rather than a bogus model id reaching the provider (or
  // a per-node retry+NodeFailed cycle). The resolved model is per-node and
  // persisted on DAG.NodeStarted so a replay sees which model actually ran.
  const resolvedModel: Record<string, string> = {}
  for (const id of Object.keys(topo.nodes)) {
    resolvedModel[id] = resolveNodeModel(topo.nodes[id]!, deps)
  }

  // Persist the declaration (event-sourced aggregate) — only on a FRESH run.
  if (!isResume) {
    await deps.events.append(dagId, "DAG.Declared", { dagId, spec }, "dag")
  }

  // Node state kept in memory for the run; durable mirror via append.
  const status: Record<string, NodeState> = {}
  const running = new Map<string, AbortController>()
  const attempts = new Map<string, number>()
  const maxRetries = deps.maxRetries ?? 2
  const pendingSkips: { nodeId: string; reason: string }[] = []
  const abortEmitted = new Set<string>()
  for (const id of Object.keys(topo.nodes)) status[id] = "pending"
  // Nodes outside the `entry`-derived active set are never dispatched. Mark them
  // skipped up front so `waitForTerminal` can settle (and a consumer replay sees
  // them terminal, not pending-forever).
  for (const id of Object.keys(topo.nodes)) {
    if (!topo.active.has(id)) status[id] = "skipped"
  }

  if (isResume) {
    // R1 resume: fold the EXISTING log so terminal nodes stay terminal and the
    // slot store is rebuilt from persisted NodeResolved outputs — a crash
    // between writes does not lose what already settled.
    const prior = foldDAG(await deps.events.read(dagId))
    for (const id of Object.keys(prior.status)) status[id] = prior.status[id]!
    // Rebuild slots (consumes may reference a node from the PRIOR run).
    for (const res of Object.values(prior.results)) {
      slotStore.set(dagId, res.nodeId, res.slotId, { output: res.output ?? "", outputRef: res.outputRef ?? `session:${res.sessionId ?? res.nodeId}` })
    }
    // A node the prior run left 'running' is dead now (process died mid-node);
    // the loop guards cancelled runs, but mark it pending so pump re-dispatches
    // it (the durable NodeAborted/NodeFailed paths were never reached).
    for (const id of Object.keys(prior.status)) {
      if (status[id] === "running") status[id] = "pending"
    }
  }

  let aborted = false
  let stopped = false

  /** Abort the whole graph: stop claiming new nodes, abort in-flight, mark the
   * graph aborted. Mirrors spec §3.3 (abort-graph). */
  const abortGraph = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await deps.events.append(dagId, "DAG.Aborted", { dagId }, "dag")
    for (const ctrl of running.values()) ctrl.abort()
    // In-flight nodes become aborted (persisted) — they must not settle as
    // succeeded after an abort. runNode also guards, but this is the durable
    // terminal marker.
    for (const id of running.keys()) {
      if (status[id] !== "running") continue
      await emitAbort(id)
    }
    // Pending nodes become skipped (persisted) so a replay rebuilds them.
    const pendingIds = Object.keys(status).filter((id) => status[id] === "pending")
    for (const id of pendingIds) {
      status[id] = "skipped"
      await emit("DAG.NodeSkipped", { nodeId: id, reason: "abort" })
    }
  }

  if (deps.signal) {
    if (deps.signal.aborted) void abortGraph()
    else deps.signal.addEventListener("abort", () => void abortGraph(), { once: true })
  }

  /** Emit a DAG event and apply it to the in-memory status. */
  const emit = async (type: string, data: Record<string, unknown>): Promise<void> => {
    await deps.events.append(dagId, type, data, "dag")
    const d = foldDAG(await deps.events.read(dagId))
    Object.assign(status, d.status)
    aborted = d.aborted || aborted
  }

  /** Emit NodeAborted at most once per node (dedupe abortGraph + runNode). */
  const emitAbort = async (id: string): Promise<void> => {
    if (abortEmitted.has(id)) return
    abortEmitted.add(id)
    await emit("DAG.NodeAborted", { nodeId: id })
  }

  /** Resolve a node's subagent, write its slot, wake dependents. */
  const runNode = async (id: string): Promise<void> => {
    const node = topo.nodes[id]!
    const ctrl = new AbortController()
    running.set(id, ctrl)
    try {
      const childSessionId = crypto.randomUUID()

      // DAG.NodeStarted marks the node as RUNNING (pump sees it claimed; a
      // replay of a half-finished graph infers "running" from it). It carries
      // the ACTUAL subagent session id so a consumer can locate the child log.
      // Emitted BEFORE the run so the node is durably claimed even if the child
      // create is slow; the child aggregate is created inside driveChildSession
      // (a crash between these two writes replays as a claimed-but-no-terminal
      // node → reconciled to aborted — the honest outcome).
      await emit("DAG.NodeStarted", { nodeId: id, sessionId: childSessionId, model: resolvedModel[id] })

      // driveChildSession: Created (location=workspace) → system context →
      // admit → runSession. toolCtx carries the node execpolicy so the child
      // keeps its hands (no deny-all fallback).
      const agent: Agent = { id: node.agent.name, model: resolvedModel[id]!, tools: [...tools] }
      const driven = await driveChildSession({
        runtime: deps.runtime,
        inbox: deps.inbox,
        events: deps.events,
        sessionId: childSessionId,
        workspace,
        agent,
        tools,
        prompt: buildInput(node, slotStore, dagId),
        parentId: dagId,
        toolCtx: nodeToolCtx,
        signal: ctrl.signal,
        contextProvider,
      })

      // A cancelled run settles with finish="interrupted" (loop returns it, does
      // NOT throw). It must NOT be recorded as succeeded/NodeResolved nor write a
      // slot — it becomes NodeAborted. Same for an abort that fired between the
      // runSession return and this write.
      if (!driven.settled || stopped) {
        await emitAbort(id)
        return
      }

      const slotId = node.produces ?? node.id
      // Capture the node's actual assistant output (not just the session ref), so
      // a downstream `consumes` can see real content, not an opaque session id.
      // Cap it to MAX_SLOT_OUTPUT so the in-memory slot and the persisted event
      // agree EXACTLY — otherwise a crash/resume would silently hand a
      // downstream node a different (truncated vs full) input. Consistency
      // beats fidelity here; the full text is still in the child's log.
      const output = driven.text.slice(0, MAX_SLOT_OUTPUT)
      const outputRef = `session:${childSessionId}`
      // Persist the output INSIDE the event — a restart can rebuild the slot
      // store from the log (resumeDag) instead of seeing only the ref.
      slotStore.set(dagId, id, slotId, { output, outputRef })
      await emit("DAG.NodeResolved", { nodeId: id, slotId, sessionId: childSessionId, outputRef, output })
    } catch (e) {
      // An aborted control flow surfaces as a cancellation (NodeAborted), not a
      // failure; a genuine failure retries up to maxRetries then NodeFailed.
      if (isCancelledSignal(e)) {
        await emitAbort(id)
        return
      }
      const reason = e instanceof Error ? e.message : String(e)
      const attempt = (attempts.get(id) ?? 0) + 1
      if (attempt <= maxRetries) {
        attempts.set(id, attempt)
        // Free the concurrency slot BEFORE flipping back to pending, so a settle-
        // triggered pump() in the next microtask cannot see the node as both
        // pending (ready) and in-flight (running) and double-dispatch it.
        running.delete(id)
        status[id] = "pending" // allow pump to re-dispatch
        await emit("DAG.NodeRetried", { nodeId: id, attempt })
      } else {
        await emit("DAG.NodeFailed", { nodeId: id, reason })
      }
    } finally {
      running.delete(id)
      ctrl.abort()
    }
  }

  // Event-driven worker pool (true no-join): whenever a node settles, pump()
  // recomputes ready and starts new nodes up to concurrency. A slow leaf never
  // blocks an unrelated branch that is already ready.
  const settle = (id: string) => status[id] === "succeeded"
  const pump = (): void => {
    if (stopped) return
    // Cascade terminal state (scheme B): a dep non-succeeded makes its dependents skipped.
    const before = { ...status }
    Object.assign(status, cascadeTerminal(topo, status))
    // Queue cascade-skipped persists (flushed before runDag returns) so a replay
    // rebuilds them. Not fire-and-forget.
    for (const id of Object.keys(status)) {
      if (status[id] === "skipped" && before[id] !== "skipped") {
        pendingSkips.push({ nodeId: id, reason: "cascade" })
      }
    }
    const ready = readyNodes(topo, status, settle)
    // Count nodes already RUNNING (claimed by a prior pump but not yet settled)
    // toward the concurrency cap. Previously `inFlight` only counted nodes
    // claimed THIS pump call and reset to 0 each time, so a slow node still in
    // flight from an earlier pump did not count — a graph could exceed its
    // declared concurrency by as many nodes as there were pump invocations.
    let inFlight = running.size
    for (const id of ready) {
      if (inFlight >= concurrency) break
      const nodeState = status[id]
      if (nodeState !== "pending") continue
      if (running.has(id)) continue // retry window: still considered in-flight
      status[id] = "running" // claim before dispatch
      inFlight++
      runNode(id)
        .catch(() => {})
        .finally(() => {
          pump() // a node settled -> recompute ready; may start more
        })
    }
  }

  pump()
  await waitForTerminal(topo, status)
  // Flush cascade-skipped persists before returning so a replay rebuilds them.
  for (const skip of pendingSkips) {
    await emit("DAG.NodeSkipped", skip)
  }
  pendingSkips.length = 0

  return { dagId, status, aborted, models: foldDAG(await deps.events.read(dagId)).models }
}

/** Poll status until every node is terminal (succeeded/failed/skipped/aborted). */
async function waitForTerminal(topology: Topology, status: Record<string, NodeState>): Promise<void> {
  const terminal = (id: string) => status[id] === "succeeded" || status[id] === "failed" || status[id] === "skipped" || status[id] === "aborted"
  while (!Object.keys(topology.nodes).every(terminal)) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * Resolve a node's effective model. Pure and deterministic (a retry resolves to
 * the same model). Precedence (spec §3.2.1):
 *   1. explicit `node.agent.model` wins;
 *   2. cost-down enabled → a cheaper model (role/preset from `modelPresets`,
 *      else `cheapModel`);
 *   3. else inherit the parent model (`defaultModel`);
 *   4. else a hard DAGError (never a bogus string like "model" reaching the
 *      provider — no-model + no-default is a config error, not a silent fallback).
 */
export function resolveNodeModel(node: DAGNode, deps: DagDeps): string {
  if (node.agent.model) return node.agent.model
  if (node.agent.role && node.agent.preset) {
    throw new DAGError(`node ${node.id} sets both role and preset for cost-down selection; pick one`)
  }
  if (deps.costDown) {
    const key = node.agent.role ?? node.agent.preset
    if (key && deps.modelPresets?.[key]) return deps.modelPresets[key]!
    if (deps.cheapModel) return deps.cheapModel
  }
  if (deps.defaultModel) return deps.defaultModel
  throw new DAGError(`node ${node.id} has no model and no cost-down/inherit default to resolve it`)
}

/** Deterministic slot→input assembly: the node's input may reference consumed
 * slots from the slot store, spliced deterministically (never LLM-organized).
 * R3: a consumed slot that is missing fails (missing-slot), never silently empty.
 * Throws DAGError so the node is marked NodeFailed, not run with empty context. */
function buildInput(node: DAGNode, slotStore: SlotStore, dagId: string): string {
  let input = node.input ?? ""
  for (const slotId of node.consumes ?? []) {
    const slot = slotStore.get(dagId, slotId)
    if (!slot) throw new DAGError(`node ${node.id} consumes missing slot "${slotId}"`)
    // Splice the upstream node's actual output (not an opaque session ref) so the
    // downstream model sees real content.
    input += `\n<slot:${slotId}>${slot.output}</slot:${slotId}>`
  }
  return input
}

/** Detect an AbortSignal-driven cancellation (AbortError / DOMException ABORT_ERR). */
function isCancelledSignal(e: unknown): boolean {
  const err = e as { name?: string; code?: number } | null
  if (!err) return false
  return err.name === "AbortError" || err.name === "SessionCancelled" || (typeof err.code === "number" && err.code === 20)
}

/**
 * Replay a DAG's state from its durable event log (post-crash/restart). Folds
 * the DAG aggregate and then reconciles any node left "running" — a process died
 * mid-node — to aborted, so the restored picture never shows a running node
 * that has no live process. Then applies cascadeTerminal so a node whose dep is
 * non-succeeded is skipped on replay too, not left pending-forever. This is the
 * R1 "replayable DAG" entry point.
 */
export async function replayDag(events: EventStore, dagId: string): Promise<DagOutcome> {
  const stored = await events.read(dagId)
  const folded = foldDAG(stored)
  const status = reconcile(folded)
  // Rebuild topology from the persisted declaration so cascadeTerminal can mark
  // a dep-non-succeeded node skipped (a live run does this; the replay path
  // previously did not, so a cascade-skipped node replayed as pending forever).
  const decl = stored.find((e) => e.type === "DAG.Declared")
  const spec = (decl?.data as { spec?: DAGSpec } | undefined)?.spec
  // Seed every declared node to pending before cascade so a node with no events
  // (never dispatched) is present and can be marked skipped when its dep is
  // non-succeeded — foldDAG only records nodes that have durable events.
  if (spec) {
    const topo = validate(spec)
    for (const id of Object.keys(spec.nodes)) if (status[id] === undefined) status[id] = "pending"
    // Reconcile inactive nodes to skipped (a live run marks them so at dispatch).
    for (const id of Object.keys(spec.nodes)) {
      if (!topo.active.has(id)) status[id] = "skipped"
    }
    return { dagId, status: cascadeTerminal(topo, status), aborted: folded.aborted, models: folded.models }
  }
  return { dagId, status, aborted: folded.aborted, models: folded.models }
}

/**
 * Resume a crashed DAG (R1): rebuild the slot store from the persisted log and
 * re-drive the nodes that never reached a terminal state. Uses the same runDag
 * pump (seeded via `resume`), so a half-finished graph continues rather than
 * being viewed as a corpse. Throws if the dagId has no declared spec.
 */
export async function resumeDag(dagId: string, spec: DAGSpec, deps: DagDeps): Promise<DagOutcome> {
  const stored = await deps.events.read(dagId)
  if (!stored.some((e) => e.type === "DAG.Declared")) throw new DAGError(`no declared DAG with id ${dagId}`)
  return runDag(spec, { ...deps, resume: { dagId } })
}

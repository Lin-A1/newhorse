import type { StoredEvent, UnknownRecord } from "@newhorse/schema"

/**
 * Declarative DAG for scheduling subagents (core half — pure topology + fold).
 *
 * This module contains the data model, validation, and the foldDAG read-model
 * that reconstructs DAG state from its event log. It intentionally does NOT
 * drive concurrency — the runtime dispatcher (packages/runtime) consumes these
 * to spawn subagents, honor per-node models, and walk a ready-queue.
 *
 * A node is one subagent delegation; edges are declared dependencies; execution
 * is ready-queue + event wakeup with no join blocking; each node can pick its
 * own model (cost balance). The graph is drawn forward and is an execution
 * spec, not a background-task list or a post-hoc lineage.
 */
export interface AgentSpec {
  readonly name: string
  readonly model?: string
  readonly tools?: readonly string[]
  /** Cost-down selection key: a role to map to a cheaper model under costDown. */
  readonly role?: string
  /** Cost-down selection key: a preset to map to a cheaper model under costDown. */
  readonly preset?: string
}

export interface DAGNode {
  readonly id: string
  /** The subagent delegation (an agent + optional per-node model). */
  readonly agent: AgentSpec
  /** Task description fed into the subagent. */
  readonly input?: string
  /** Declared dependencies (a DAG edge). */
  readonly dependsOn?: readonly string[]
  /** Slots this node consumes from ancestors (data contract). */
  readonly consumes?: readonly string[]
  /** Slot this node produces; defaults to its id (single product per node). */
  readonly produces?: string
}

export interface DAGSpec {
  readonly nodes: Readonly<Record<string, DAGNode>>
  readonly entry?: readonly string[]
}

export type NodeState = "pending" | "running" | "succeeded" | "failed" | "skipped" | "aborted"

export interface NodeResult {
  readonly nodeId: string
  readonly slotId: string
  readonly sessionId?: string
  readonly outputRef?: string
  readonly status: "succeeded" | "failed" | "skipped"
}

/** DAG aggregate event payloads. They live on a separate aggregate id (dagId). */
export type DAGEvent = UnknownRecord & {
  readonly type:
    | "DAG.Declared"
    | "DAG.NodeStarted"
    | "DAG.NodeResolved"
    | "DAG.NodeFailed"
    | "DAG.NodeSkipped"
    | "DAG.NodeAborted"
    | "DAG.NodeRetried"
    | "DAG.Aborted"
}

/** Topology computed once from a spec: deduped edges, in-degree, deps. */
export interface Topology {
  readonly nodes: Readonly<Record<string, DAGNode>>
  /** nodeId -> deduped set of its dependency nodeIds. */
  readonly deps: Readonly<Record<string, string[]>>
  /** nodeId -> deduped in-degree. */
  readonly inDegree: Readonly<Record<string, number>>
  /** nodeId -> nodeIds that depend on it. */
  readonly dependents: Readonly<Record<string, string[]>>
  /** nodeIds reachable from `entry` (or from every in-degree-0 root when entry
   * is absent). Nodes outside `active` are never dispatched. */
  readonly active: ReadonlySet<string>
}

export class DAGError extends Error {
  readonly _tag = "DAGError"
  readonly reason: string
  constructor(reason: string) {
    super(`DAG: ${reason}`)
    this.name = "DAGError"
    this.reason = reason
  }
}

/** Validate the spec, fail-fast on cycle / unknown dep / self dep. */
export function validate(spec: DAGSpec): Topology {
  const nodes = spec.nodes
  const nodeIds = Object.keys(nodes)

  // Edge de-dup + build adjacency.
  const deps: Record<string, string[]> = {}
  const dependents: Record<string, string[]> = {}
  for (const id of nodeIds) {
    deps[id] = []
    dependents[id] = []
  }
  for (const id of nodeIds) {
    const node = nodes[id]!
    for (const raw of node.dependsOn ?? []) {
      if (raw === id) throw new DAGError(`self-dep ${id}`)
      if (!nodes[raw]) throw new DAGError(`unknown dep ${raw} referenced by ${id}`)
      if (!deps[id]!.includes(raw)) {
        deps[id]!.push(raw)
        dependents[raw]!.push(id)
      }
    }
  }

  // An `entry` id must exist. A private/dangling entry would otherwise silently
  // narrow the graph to nothing (or, worse, be ignored entirely).
  for (const id of spec.entry ?? []) {
    if (!nodes[id]) throw new DAGError(`unknown entry ${id}`)
    // An entry is a scheduling root, so it must already be ready when the graph
    // starts. If it had deps, those deps would sit OUTSIDE the forward-reachable
    // `active` set and the entry would never become ready (permanent stranding).
    if ((deps[id] ?? []).length > 0) throw new DAGError(`entry ${id} has dependencies and would never be dispatched`)
  }

  // Cycle detection (Kahn): nodes with in-degree 0 seeded; count processed.
  const inDegree: Record<string, number> = {}
  for (const id of nodeIds) inDegree[id] = deps[id]!.length
  const queue = nodeIds.filter((id) => inDegree[id] === 0)
  let seen = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    seen++
    for (const dep of dependents[id]!) {
      inDegree[dep]!--
      if (inDegree[dep] === 0) queue.push(dep)
    }
  }
  if (seen !== nodeIds.length) throw new DAGError("cycle detected")

  // Recompute in-degree for the returned topology (Kahn mutated the work copy).
  const settledDegree: Record<string, number> = {}
  for (const id of nodeIds) settledDegree[id] = deps[id]!.length

  // R3: every node's `consumes` must be a slot produced by one of its ancestors
  // (dependency closure). A node's produced slot is `produces ?? id`.
  const producedBy = (id: string): string[] => {
    const out: string[] = []
    for (const dep of deps[id]!) {
      out.push(nodes[dep]!.produces ?? dep)
      out.push(...producedBy(dep))
    }
    return out
  }
  for (const id of nodeIds) {
    const node = nodes[id]!
    const ancestors = producedBy(id)
    for (const slot of node.consumes ?? []) {
      if (!ancestors.includes(slot)) {
        throw new DAGError(`node ${id} consumes "${slot}" but no ancestor produces it`)
      }
    }
  }

  // R4: two nodes must not declare the same `produces` slot id. The slot store
  // is keyed by slot id, so a duplicate would let a later node silently
  // overwrite an earlier node's output (last-writer-wins) with no way for a
  // consumer to see the loss. Each produced slot must be unique across the graph.
  const producedSlots = new Map<string, string>()
  for (const id of nodeIds) {
    const slot = nodes[id]!.produces ?? id
    const prior = producedSlots.get(slot)
    if (prior !== undefined && prior !== id) {
      throw new DAGError(`duplicate produces slot "${slot}" from nodes ${prior} and ${id}`)
    }
    producedSlots.set(slot, id)
  }

  return { nodes, deps, inDegree: settledDegree, dependents, active: activeSet(spec, dependents, settledDegree, nodeIds) }
}

/** The nodes reachable FORWARD from the scheduled roots. Roots are the declared
 * `entry` nodes (default: every in-degree-0 node). Node X is active iff it is an
 * entry root or transitively depends on one — i.e. it sits on a path that an
 * entry can actually reach. Nodes outside `active` are never dispatched. */
function activeSet(spec: DAGSpec, dependents: Record<string, string[]>, inDegree: Record<string, number>, nodeIds: string[]): Set<string> {
  const roots = spec.entry && spec.entry.length > 0
    ? spec.entry
    : nodeIds.filter((id) => inDegree[id] === 0)
  const scope = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (scope.has(id)) continue
    scope.add(id)
    for (const depId of dependents[id] ?? []) stack.push(depId)
  }
  return scope
}

/** The DAG aggregate fold: reconstruct status / results / aborted from events. */
export function foldDAG(events: StoredEvent[]): { status: Record<string, NodeState>; results: Record<string, NodeResult>; aborted: boolean; attempts: Record<string, number>; models: Record<string, string> } {
  const status: Record<string, NodeState> = {}
  const results: Record<string, NodeResult> = {}
  const attempts: Record<string, number> = {}
  const models: Record<string, string> = {}
  let aborted = false

  for (const e of events) {
    switch (e.type) {
      case "DAG.NodeStarted": {
        const d = e.data as { nodeId?: string; model?: string }
        if (d.nodeId) {
          status[d.nodeId] = "running"
          if (d.model) models[d.nodeId] = d.model
        }
        break
      }
      case "DAG.NodeResolved": {
        const d = e.data as { nodeId?: string; slotId?: string; sessionId?: string; outputRef?: string }
        if (d.nodeId) {
          status[d.nodeId] = "succeeded"
          results[d.slotId ?? d.nodeId] = { nodeId: d.nodeId, slotId: d.slotId ?? d.nodeId, sessionId: d.sessionId, outputRef: d.outputRef, status: "succeeded" }
        }
        break
      }
      case "DAG.NodeFailed":
        if (e.data.nodeId) status[e.data.nodeId as string] = "failed"
        break
      case "DAG.NodeSkipped":
        if (e.data.nodeId) status[e.data.nodeId as string] = "skipped"
        break
      case "DAG.NodeAborted":
        if (e.data.nodeId) status[e.data.nodeId as string] = "aborted"
        break
      case "DAG.NodeRetried":
        if (e.data.nodeId) {
          attempts[e.data.nodeId as string] = (e.data.attempt as number) ?? 1
          status[e.data.nodeId as string] = "pending"
        }
        break
      case "DAG.Aborted":
        aborted = true
        break
      default:
        break
    }
  }

  return { status, results, aborted, attempts, models }
}

/**
 * Reconcile (R1): a node still "running" at the end of a folded log never
 * settled — a process died mid-node. Treat it as aborted (never resettle side
 * effects) rather than leaving it running without a live process. Applied only
 * when replaying a finished/historical DAG, not on every live fold.
 */
export function reconcile(folded: { status: Record<string, NodeState> }): Record<string, NodeState> {
  const status = { ...folded.status }
  for (const id of Object.keys(status)) {
    if (status[id] === "running") status[id] = "aborted"
  }
  return status
}

/** Cascade terminal state (scheme B): a node whose dep is non-succeeded is
 * terminal (failed/skipped), not dispatched, never left pending-forever.
 * Iterates to a fixed point so the cascade is transitive (a skipped dep is
 * also a non-succeeded dep for its own dependents). */
export function cascadeTerminal(topology: Topology, status: Record<string, NodeState>): Record<string, NodeState> {
  const next = { ...status }
  let changed = true
  while (changed) {
    changed = false
    for (const id of Object.keys(topology.nodes)) {
      if (next[id] !== "pending") continue
      if (!topology.active.has(id)) continue
      const deps = topology.deps[id]!
      const hasNonSucceeded = deps.some((d) => {
        const st = next[d]
        return st === "failed" || st === "skipped" || st === "aborted"
      })
      if (hasNonSucceeded) {
        next[id] = "skipped"
        changed = true
      }
    }
  }
  return next
}

/** Ready queue for the dispatcher: pending ACTIVE nodes whose in-degree is
 * satisfied. Inactive nodes are never dispatched even if they look ready. */
export function readyNodes(topology: Topology, status: Record<string, NodeState>, settled: (id: string) => boolean): string[] {
  return Object.keys(topology.nodes).filter((id) => {
    if (!topology.active.has(id)) return false
    if (status[id] !== "pending") return false
    const deps = topology.deps[id]!
    return deps.every((d) => settled(d))
  })
}

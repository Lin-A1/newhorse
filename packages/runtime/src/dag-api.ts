import { Database } from "bun:sqlite"
import { join } from "node:path"
import { MemorySessionInput, SqliteEventStore, type EventStore, type DAGSpec } from "@newhorse/core"
import { createBuiltinTools } from "./tools"
import { makeLlmClient, type AdapterConfig, type Fetcher } from "@newhorse/llm"
import type { MemoryStore } from "@newhorse/memory"

/**
 * Server-side DAG runner (the client's 编排 page backing): builds a DURABLE
 * runtime over the dataDir's event store (aggregate "dag" — replayable and
 * resumable) and runs declared specs fire-and-forget. Provider/model resolve
 * through getters so settings changes reach the next run.
 */
export interface DagRunnerOpts {
  readonly dataDir: string
  readonly getProvider: () => AdapterConfig
  readonly getDefaultModel: () => string
  readonly getWorkspace: () => string
  readonly enableBash?: boolean
  readonly memoryStore?: MemoryStore
  readonly skillsDir?: string
  readonly events?: EventStore
  readonly todoSessionId?: string
  readonly fetch?: Fetcher
}

export interface DagNodeStatus {
  readonly node: string
  readonly state: "pending" | "running" | "succeeded" | "failed" | "skipped" | "aborted"
  readonly model?: string
}

export interface DagStatus {
  readonly dagId: string
  readonly nodes: DagNodeStatus[]
  readonly done: boolean
  readonly startedAt?: number
}

export interface DagRunner {
  /** Declare + run a spec (durable; awaited until the graph SETTLES — the
   *  endpoint calls this fire-and-forget and returns the dagId immediately). */
  readonly run: (spec: DAGSpec, opts?: { workspace?: string; todoSessionId?: string }) => Promise<{ dagId: string }>
  readonly status: (dagId: string) => Promise<DagStatus | undefined>
  readonly list: () => Promise<DagStatus[]>
}

/** Fold DAG events for one aggregate into node statuses. */
function foldStatus(dagId: string, rows: Array<{ type: string; data: Record<string, unknown>; createdAt: number | null }>): DagStatus | undefined {
  if (rows.length === 0) return undefined
  const nodes = new Map<string, DagNodeStatus>()
  let startedAt: number | undefined
  let done = true
  for (const r of rows) {
    if (startedAt === undefined && r.createdAt !== null) startedAt = r.createdAt
    if (r.type === "DAG.Declared") continue
    const d = r.data as { node?: string; model?: string }
    if (!d.node) continue
    let state: DagNodeStatus["state"] = "pending"
    if (r.type === "DAG.NodeStarted") state = "running"
    else if (r.type === "DAG.NodeResolved") state = "succeeded"
    else if (r.type === "DAG.NodeFailed") state = "failed"
    else if (r.type === "DAG.NodeSkipped") state = "skipped"
    const prev = nodes.get(d.node)
    // terminal states stick
    if (prev && (prev.state === "succeeded" || prev.state === "failed" || prev.state === "skipped")) continue
    nodes.set(d.node, { node: d.node, state, model: d.model ?? prev?.model })
  }
  for (const n of nodes.values()) if (n.state === "running" || n.state === "pending") done = false
  return {
    dagId,
    nodes: [...nodes.values()].sort((a, b) => a.node.localeCompare(b.node)),
    done,
    startedAt,
  }
}

export function createDagRunner(opts: DagRunnerOpts): DagRunner {
  const events: EventStore = opts.events ?? SqliteEventStore.open(join(opts.dataDir, "events.db"))
  const inbox = new MemorySessionInput(events)
  const tools = createBuiltinTools({ workspace: opts.getWorkspace(), enableBash: opts.enableBash ?? false, memoryStore: opts.memoryStore, skillsDir: opts.skillsDir, events })
  const fetch = opts.fetch ?? globalThis.fetch.bind(globalThis)

  async function runSpec(spec: DAGSpec, runOpts?: { workspace?: string; todoSessionId?: string }): Promise<{ dagId: string }> {
    const { runDag } = await import("./dag-runner")
    const runtime = { events, inbox, llm: makeLlmClient(opts.getProvider(), fetch) }
    return runDag(spec, {
      events,
      inbox,
      runtime,
      tools,
      workspace: runOpts?.workspace ?? opts.getWorkspace(),
      defaultModel: opts.getDefaultModel(),
      todoSessionId: runOpts?.todoSessionId ?? opts.todoSessionId,
    })
  }

  return {
    async run(spec, runOpts) {
      // Caller-supplied id: the endpoint returns it immediately while the
      // graph keeps driving fire-and-forget. A failed driver leaves the
      // Declared event absent — status() then reports undefined (honest).
      const dagId = crypto.randomUUID()
      const { runDag } = await import("./dag-runner")
      void runDag(spec, {
        events,
        inbox,
        runtime: { events, inbox, llm: makeLlmClient(opts.getProvider(), fetch) },
        tools,
        workspace: runOpts?.workspace ?? opts.getWorkspace(),
        defaultModel: opts.getDefaultModel(),
        todoSessionId: runOpts?.todoSessionId ?? opts.todoSessionId,
        dagId,
      }).catch(() => {
        // Node failures are recorded on the dag aggregate; the runner never
        // throws past settlement.
      })
      return { dagId }
    },
    async status(dagId) {
      const evs = await events.read(dagId).catch(() => [])
      return foldStatus(
        dagId,
        evs.map((e) => ({ type: e.type, data: e.data, createdAt: e.ts ?? null })),
      )
    },
    async list() {
      const db = new Database(join(opts.dataDir, "events.db"), { readonly: true })
      try {
        const ids = db.query("SELECT DISTINCT aggregate_id FROM event WHERE aggregate = 'dag' ORDER BY aggregate_id DESC").all() as { aggregate_id: string }[]
        const out: DagStatus[] = []
        for (const { aggregate_id } of ids) {
          const rows = db.query("SELECT type, data, created_at FROM event WHERE aggregate_id = ? AND aggregate = 'dag' ORDER BY seq ASC").all(aggregate_id) as Array<{ type: string; data: string; created_at: number | null }>
          const st = foldStatus(
            aggregate_id,
            rows.map((r) => ({ type: r.type, data: JSON.parse(r.data) as Record<string, unknown>, createdAt: r.created_at })),
          )
          if (st) out.push(st)
        }
        return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      } finally {
        db.close()
      }
    },
  }
}

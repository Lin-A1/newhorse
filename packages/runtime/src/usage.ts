import { Database } from "bun:sqlite"

/**
 * Usage aggregation (the client's usage-heatmap data): fold every session's
 * `Session.StepEnded` usage out of the durable event log into per-day totals.
 * Read-only over the dataDir's events.db (WAL allows a concurrent reader).
 * The domain fold lives here in the runtime — the server stays transport-only.
 *
 * Time comes from the store-level `created_at` column (added alongside this
 * feature; legacy rows carry NULL and are honestly excluded from time-based
 * views rather than backfilled with a fake time). Model attribution uses the
 * session's model (SessionRow.model — the agent that ran the steps).
 */
export interface UsagePoint {
  /** Local date, YYYY-MM-DD. */
  readonly day: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly cost: number
  readonly steps: number
  /** Output tokens per model (heatmap stacks / per-model breakdown). */
  readonly byModel: Record<string, { inputTokens: number; outputTokens: number }>
}

export interface UsageSummary {
  readonly days: UsagePoint[]
  readonly totals: { inputTokens: number; outputTokens: number; steps: number }
  readonly sessions: number
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export async function aggregateUsage(dbPath: string, days = 30, now = Date.now()): Promise<UsageSummary> {
  const db = new Database(dbPath, { readonly: true })
  try {
    const cutoff = now - days * 86_400_000
    // One scan over the folded event type — no per-session reads.
    const rows = db
      .query("SELECT aggregate_id, data, created_at FROM event WHERE type = ? AND created_at IS NOT NULL AND created_at >= ? ORDER BY created_at ASC")
      .all("Session.StepEnded", cutoff) as { aggregate_id: string; data: string; created_at: number }[]
    // Session models + createdAt fallback for attribution and time mapping.
    const sessionModels = new Map<string, string>()
    const sessionCreated = new Map<string, number>()
    const modelRows = db
      .query(`SELECT aggregate_id, data, created_at FROM event WHERE type IN ('Session.MessageAppended', 'Session.AgentSet', 'Session.Created') ORDER BY aggregate_id, seq ASC`)
      .all() as { aggregate_id: string; data: string; created_at: number | null }[]
    for (const r of modelRows) {
      try {
        const d = JSON.parse(r.data) as { message?: { kind?: string; model?: string }; model?: string; createdAt?: number }
        const model = d.message?.model ?? d.model
        if (model) sessionModels.set(r.aggregate_id, model)
        // Session.Created carries createdAt in data — use as fallback for sessions
        // whose StepEnded events lack created_at (legacy rows).
        if (d.createdAt && !sessionCreated.has(r.aggregate_id)) sessionCreated.set(r.aggregate_id, d.createdAt)
      } catch {
        // A corrupt row never breaks the aggregate.
      }
    }

    const byDay = new Map<string, UsagePoint>()
    const totals = { inputTokens: 0, outputTokens: 0, steps: 0 }
    const touchedSessions = new Set<string>()
    for (const r of rows) {
      let data: { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; cost?: number } }
      try {
        data = JSON.parse(r.data) as typeof data
      } catch {
        continue
      }
      const usage = data.usage ?? {}
      // created_at present → use it; legacy NULL → fall back to the session's
      // Created.createdAt (better than silently dropping the data).
      const ts = r.created_at ?? sessionCreated.get(r.aggregate_id) ?? 0
      if (ts === 0) continue
      const day = dayKey(ts)
      const model = sessionModels.get(r.aggregate_id) ?? "unknown"
      const prev = byDay.get(day) ?? { day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0, steps: 0, byModel: {} }
      const bm = prev.byModel[model] ?? { inputTokens: 0, outputTokens: 0 }
      const point: UsagePoint = {
        ...prev,
        inputTokens: prev.inputTokens + (usage.inputTokens ?? 0),
        outputTokens: prev.outputTokens + (usage.outputTokens ?? 0),
        cacheReadTokens: prev.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: prev.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        reasoningTokens: prev.reasoningTokens + (usage.reasoningTokens ?? 0),
        cost: prev.cost + (usage.cost ?? 0),
        steps: prev.steps + 1,
        byModel: { ...prev.byModel, [model]: { inputTokens: bm.inputTokens + (usage.inputTokens ?? 0), outputTokens: bm.outputTokens + (usage.outputTokens ?? 0) } },
      }
      byDay.set(day, point)
      totals.inputTokens += usage.inputTokens ?? 0
      totals.outputTokens += usage.outputTokens ?? 0
      totals.steps += 1
      touchedSessions.add(r.aggregate_id)
    }
    return { days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)), totals, sessions: touchedSessions.size }
  } finally {
    db.close()
  }
}

import type { StoredEvent } from "@newhorse/schema"

/**
 * Goal layer (borrowed from codex `ext/goal` ThreadGoal): the WHY above the
 * todo list and the DAG — an objective, a status, and an optional token
 * budget enforced against the usage already persisted in Session.StepEnded.
 *
 * The goal is durable (event-sourced, unlike codex's transient plan): the
 * current goal is the LAST Session.GoalUpdated event; tokens_used aggregates
 * the session's own StepEnded usage — so budget enforcement is replay-safe.
 */

export type GoalStatus = "active" | "paused" | "blocked" | "complete"

export interface GoalState {
  readonly objective: string
  readonly status: GoalStatus
  readonly tokenBudget?: number
  readonly tokensUsed: number
}

/** Fold the current goal + the session's aggregated usage from the log. */
export function currentGoal(stored: StoredEvent[]): GoalState | undefined {
  const last = [...stored].reverse().find((e) => e.type === "Session.GoalUpdated")
  if (!last) return undefined
  const d = last.data as { objective?: string; status?: GoalStatus; tokenBudget?: number }
  if (!d.objective) return undefined
  return {
    objective: d.objective,
    status: d.status ?? "active",
    ...(d.tokenBudget !== undefined ? { tokenBudget: d.tokenBudget } : {}),
    tokensUsed: tokensUsed(stored),
  }
}

/** Aggregate the session's persisted LLM usage (input+output tokens per step). */
export function tokensUsed(stored: StoredEvent[]): number {
  let total = 0
  for (const e of stored) {
    if (e.type !== "Session.StepEnded") continue
    const u = (e.data as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    if (!u) continue
    total += (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
  }
  return total
}

/** Validate a goal write. */
export function validateGoal(objective: unknown, status: unknown, tokenBudget?: unknown): { objective: string; status: GoalStatus; tokenBudget?: number } | { error: string } {
  if (typeof objective !== "string" || objective.trim().length === 0) return { error: "objective is required" }
  if (objective.trim().length > 4000) return { error: "objective too long (max 4000 chars, codex ThreadGoal parity)" }
  if (typeof status !== "string" || !["active", "paused", "blocked", "complete"].includes(status)) {
    return { error: 'status must be active|paused|blocked|complete' }
  }
  const out: { objective: string; status: GoalStatus; tokenBudget?: number } = { objective: objective.trim(), status: status as GoalStatus }
  if (tokenBudget !== undefined) {
    if (typeof tokenBudget !== "number" || !Number.isFinite(tokenBudget) || tokenBudget <= 0) return { error: "tokenBudget must be a positive number" }
    out.tokenBudget = Math.floor(tokenBudget)
  }
  return out
}

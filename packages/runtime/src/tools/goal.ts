import type { Tool, ToolCtx, EventStore } from "@newhorse/core"
import { currentGoal, tokensUsed, validateGoal } from "@newhorse/core"

/**
 * goal tools (codex ThreadGoal pattern): the WHY above the todo list — an
 * objective with an optional token budget enforced against the session's own
 * persisted usage. Durable (event-sourced), unlike codex's transient plan.
 */

/** Build goal_write (set/update the session's goal) + goal_read (status + budget state). */
export function createGoalTools(events: EventStore): Tool[] {
  const write: Tool = {
    name: "goal_write",
    description: "Set or update this session's GOAL — the objective above the todo list. Args: { objective (max 4000 chars), status: active|paused|blocked|complete, tokenBudget? (positive number; the run is budget-aware via persisted usage) }.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        status: { type: "string", enum: ["active", "paused", "blocked", "complete"] },
        tokenBudget: { type: "number" },
      },
      required: ["objective", "status"],
    },
    execute: async (input: unknown, ctx?: ToolCtx) => {
      const { objective, status, tokenBudget } = (input ?? {}) as { objective?: unknown; status?: unknown; tokenBudget?: unknown }
      const check = validateGoal(objective, status ?? "active", tokenBudget)
      if ("error" in check) return { error: check.error }
      const sessionId = ctx?.sessionId
      if (!sessionId) return { error: "goal_write requires a session ctx" }
      await events.append(sessionId, "Session.GoalUpdated", { sessionId, ...check, ts: Date.now() })
      return { goal: check }
    },
  }

  const read: Tool = {
    name: "goal_read",
    sideEffects: false,
    description: "Read the current goal: objective, status, tokens used, and budget remaining (over-budget is flagged).",
    inputSchema: { type: "object", properties: {} },
    execute: async (_input: unknown, ctx?: ToolCtx) => {
      const sessionId = ctx?.sessionId
      if (!sessionId) return { error: "goal_read requires a session ctx" }
      const goal = currentGoal(await events.read(sessionId))
      if (!goal) return { goal: null }
      const remaining = goal.tokenBudget !== undefined ? goal.tokenBudget - goal.tokensUsed : undefined
      return { ...goal, tokensRemaining: remaining, overBudget: goal.tokenBudget !== undefined && goal.tokensUsed > goal.tokenBudget }
    },
  }
  return [write, read]
}

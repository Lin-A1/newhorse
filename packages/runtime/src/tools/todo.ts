import type { Tool, ToolCtx, EventStore } from "@newhorse/core"
import { validateTodoWrite } from "@newhorse/core"

/**
 * todo_write — the model's self-organization tool (opencode `todowrite` shape:
 * full-replace; the whole normalized list is echoed back as the result so the
 * model never has to track state from history alone). The write is durable:
 * a Session.TodoUpdated event on the session aggregate, so the list survives
 * restarts and is visible to shells/UIs folding the log.
 */
export function createTodoWriteTool(events: EventStore): Tool {
  return {
    name: "todo_write",
    description: 'Write the FULL task list (replaces the previous one). Each item: { content (short imperative), status: "pending"|"in_progress"|"completed"|"cancelled", activeForm? (present-continuous, shown while working) }. Rules: at most ONE in_progress; mark completed immediately when done (do not batch); an empty list clears the list. Max 50 items. Use for multi-step tasks (3+ steps).',
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
              activeForm: { type: "string" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    execute: async (input: unknown, ctx?: ToolCtx) => {
      const { todos } = (input ?? {}) as { todos?: unknown }
      const check = validateTodoWrite(todos)
      if ("error" in check) return { error: check.error } // model-readable denial
      const sessionId = ctx?.sessionId
      if (!sessionId) return { error: "todo_write requires a session ctx" }
      await events.append(sessionId, "Session.TodoUpdated", { sessionId, todos: check.items })
      // Echo the normalized list (opencode's toModelOutput pattern): the model
      // sees the authoritative new state without re-deriving it from history.
      return { todos: check.items }
    },
  }
}

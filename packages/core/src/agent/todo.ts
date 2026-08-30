import type { StoredEvent } from "@newhorse/schema"

/**
 * Model-maintained task list (todo/plan pattern — borrowed from opencode's
 * event-sourced `todowrite` + claude code's status rules; codex's non-durable
 * plan is deliberately rejected: the list must survive a restart).
 *
 * The whole list is a snapshot per write (`Session.TodoUpdated`): the current
 * list is trivially the LAST such event in the log, projections are trivial,
 * and full-replace is the universal input shape (self-healing, no merge
 * ambiguity). Subagent isolation is free — each session folds its own log.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoItem {
  /** Short, imperative (~5 words), e.g. "Run the test suite". */
  readonly content: string
  readonly status: TodoStatus
  /** Present-continuous label for UI spinners while in_progress (claude code). */
  readonly activeForm?: string
}

/** Fold the current list: the LAST Session.TodoUpdated event wins. */
export function currentTodos(stored: StoredEvent[]): TodoItem[] {
  const last = [...stored].reverse().find((e) => e.type === "Session.TodoUpdated")
  if (!last) return []
  const todos = (last.data as { todos?: TodoItem[] }).todos
  return Array.isArray(todos) ? todos : []
}

/** Normalize + validate a write: at most ONE in_progress (claude code/codex
 *  rule); content is trimmed and length-capped; an empty list is legal (that
 *  is how a list ends). Returns an error string when the write is invalid. */
export function validateTodoWrite(todos: unknown): { items: TodoItem[] } | { error: string } {
  if (!Array.isArray(todos)) return { error: "todos must be an array" }
  if (todos.length > 50) return { error: "too many todos (max 50)" }
  let inProgress = 0
  const items: TodoItem[] = []
  for (const raw of todos) {
    if (!raw || typeof raw !== "object") return { error: "each todo must be an object" }
    const t = raw as { content?: unknown; status?: unknown; activeForm?: unknown }
    if (typeof t.content !== "string" || t.content.trim().length === 0) return { error: "todo.content is required" }
    if (t.content.trim().length > 200) return { error: "todo.content too long (max 200 chars)" }
    const status = t.status as TodoStatus
    if (!["pending", "in_progress", "completed", "cancelled"].includes(status)) {
      return { error: `todo.status must be pending|in_progress|completed|cancelled (got "${String(t.status)}")` }
    }
    if (status === "in_progress") inProgress++
    items.push({
      content: t.content.trim(),
      status,
      ...(typeof t.activeForm === "string" && t.activeForm.trim().length > 0 ? { activeForm: t.activeForm.trim().slice(0, 100) } : {}),
    })
  }
  if (inProgress > 1) return { error: `at most ONE todo can be in_progress (got ${inProgress}) — finish or pause the others first` }
  return { items }
}

import { describe, expect, it } from "bun:test"
import { MemoryEventStore, currentTodos } from "@newhorse/core"
import { createTodoWriteTool } from "./todo"

describe("todo_write tool (durable, event-sourced)", () => {
  it("writes the list to the session log and echoes the normalized state", async () => {
    const events = new MemoryEventStore()
    const tool = createTodoWriteTool(events)
    const res = await tool.execute(
      { todos: [{ content: "write code", status: "completed" }, { content: "review", status: "in_progress", activeForm: "Reviewing" }] },
      { caller: { kind: "user" }, sessionId: "s1" },
    )
    // Echo: the model sees the authoritative new list.
    const echoed = res as { todos?: { content: string; status: string; activeForm?: string }[] }
    expect(echoed.todos?.length).toBe(2)
    expect(echoed.todos?.[1]?.activeForm).toBe("Reviewing")
    // Durable: the fold rebuilds it from the log (restart-safe).
    expect(currentTodos(await events.read("s1")).length).toBe(2)
  })

  it("a validation error is a model-readable denial (nothing logged)", async () => {
    const events = new MemoryEventStore()
    const tool = createTodoWriteTool(events)
    const res = await tool.execute({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] }, { caller: { kind: "user" }, sessionId: "s1" })
    expect((res as { error?: string }).error).toContain("at most ONE")
    // No event was written for a rejected write.
    expect((await events.read("s1")).length).toBe(0)
  })
})

import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "../session/store"
import { currentTodos, validateTodoWrite } from "./todo"

describe("validateTodoWrite", () => {
  it("accepts a normal write and normalizes content", () => {
    const res = validateTodoWrite([{ content: "  run tests  ", status: "in_progress", activeForm: "Running tests" }])
    if ("error" in res) throw new Error(res.error)
    expect(res.items[0]!.content).toBe("run tests")
    expect(res.items[0]!.activeForm).toBe("Running tests")
  })

  it("rejects more than one in_progress (claude code / codex rule)", () => {
    const res = validateTodoWrite([
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
    ]) as { error?: string }
    expect(res.error).toContain("at most ONE")
  })

  it("rejects a bad status and empty content", () => {
    expect("error" in validateTodoWrite([{ content: "a", status: "done" }])).toBe(true)
    expect("error" in validateTodoWrite([{ content: "", status: "pending" }])).toBe(true)
  })

  it("an empty list is legal (how a list ends)", () => {
    expect("items" in validateTodoWrite([])).toBe(true)
  })
})

describe("currentTodos (event-sourced fold)", () => {
  it("rebuilds the list from the LAST TodoUpdated event (restart-safe)", async () => {
    const events = new MemoryEventStore()
    await events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
    await events.append("s", "Session.TodoUpdated", { sessionId: "s", todos: [{ content: "step one", status: "completed" }] })
    await events.append("s", "Session.MessageAppended", { sessionId: "s", message: { kind: "assistant", id: "m", seq: 9, content: [{ type: "text", text: "x" }], model: "m" } })
    await events.append("s", "Session.TodoUpdated", { sessionId: "s", todos: [{ content: "step one", status: "completed" }, { content: "step two", status: "in_progress" }] })
    const todos = currentTodos(await events.read("s"))
    expect(todos.length).toBe(2)
    expect(todos[1]!.status).toBe("in_progress")
  })

  it("returns empty for a session with no todos", async () => {
    const events = new MemoryEventStore()
    await events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
    expect(currentTodos(await events.read("s"))).toEqual([])
  })
})

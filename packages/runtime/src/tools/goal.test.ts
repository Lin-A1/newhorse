import { describe, expect, it } from "bun:test"
import { MemoryEventStore, currentGoal, type Tool } from "@newhorse/core"
import { createGoalTools } from "./goal"

describe("goal tools (durable, budget-aware)", () => {
  it("write then read: budget remaining + over-budget flag from persisted usage", async () => {
    const events = new MemoryEventStore()
    const [write, read] = createGoalTools(events) as [Tool, Tool]
    await events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
    await events.append("s", "Session.StepEnded", { sessionId: "s", step: 1, finish: "stop", usage: { inputTokens: 300, outputTokens: 200 } })

    const w = await write.execute({ objective: "finish the runtime", status: "active", tokenBudget: 400 }, { caller: { kind: "user" }, sessionId: "s" })
    expect((w as { goal?: { objective: string } }).goal?.objective).toBe("finish the runtime")

    const r = (await read.execute({}, { caller: { kind: "user" }, sessionId: "s" })) as { tokensUsed?: number; tokensRemaining?: number; overBudget?: boolean }
    expect(r.tokensUsed).toBe(500)
    expect(r.tokensRemaining).toBe(-100)
    expect(r.overBudget).toBe(true)
    // The fold agrees (durable, restart-safe); overBudget is tool-computed.
    const folded = currentGoal(await events.read("s"))
    expect(folded?.tokensUsed).toBe(500)
    expect(folded?.tokenBudget).toBe(400)
  })
})

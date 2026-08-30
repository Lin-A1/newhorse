import { describe, expect, it } from "bun:test"
import { MemoryEventStore } from "../session/store"
import { currentGoal, tokensUsed, validateGoal } from "./goal"

async function seed(events: MemoryEventStore): Promise<void> {
  await events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
  await events.append("s", "Session.StepEnded", { sessionId: "s", step: 1, finish: "stop", usage: { inputTokens: 100, outputTokens: 50 } })
  await events.append("s", "Session.StepEnded", { sessionId: "s", step: 2, finish: "stop", usage: { inputTokens: 200, outputTokens: 100 } })
}

describe("goal (codex ThreadGoal pattern)", () => {
  it("folds the LAST GoalUpdated + aggregates persisted usage", async () => {
    const events = new MemoryEventStore()
    await seed(events)
    await events.append("s", "Session.GoalUpdated", { sessionId: "s", objective: "ship v2", status: "active", tokenBudget: 1000, ts: 1 })
    await events.append("s", "Session.GoalUpdated", { sessionId: "s", objective: "ship v2.1", status: "active", ts: 2 })
    const goal = currentGoal(await events.read("s"))
    expect(goal?.objective).toBe("ship v2.1")
    expect(goal?.tokensUsed).toBe(450) // (100+50) + (200+100)
    expect(goal?.tokenBudget).toBeUndefined() // last write had no budget
  })

  it("validateGoal rejects bad shapes (codex 4000-char parity)", async () => {
    expect("error" in validateGoal("", "active")).toBe(true)
    expect("error" in validateGoal("x", "running")).toBe(true)
    expect("error" in validateGoal("x", "active", -5)).toBe(true)
    expect("error" in validateGoal("y".repeat(4001), "active")).toBe(true)
    expect("objective" in validateGoal("ok", "paused", 500)).toBe(true)
  })

  it("tokensUsed is 0 without usage rows", async () => {
    const events = new MemoryEventStore()
    await events.append("s", "Session.Created", { id: "s", location: "/w", createdAt: Date.now() })
    expect(tokensUsed(await events.read("s"))).toBe(0)
  })
})

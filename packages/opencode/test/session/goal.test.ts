import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { SessionProjector } from "@newhorse/core/session/projector"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@newhorse/core/database/database"
import { Goal } from "../../src/session/goal"
import { Session } from "../../src/session/session"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Goal.node, Database.node, Session.node, SessionProjector.node]),
  ),
)

const newSession = () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return (yield* sessions.create({ title: "Goal test" })).id
  })

describe("goals", () => {
  it.instance("create, get, and list goals scoped by session", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = yield* newSession()

      const created = yield* goal.create({
        sessionID,
        content: "交付 P1-4 goal 系统",
        priority: "high",
        deadline: 123,
      })
      expect(created.content).toBe("交付 P1-4 goal 系统")
      expect(created.status).toBe("open")
      expect(created.priority).toBe("high")
      expect(created.deadline).toBe(123)
      expect(created.done_reason).toBeUndefined()
      expect(created.id.startsWith("goal_")).toBe(true)

      const fetched = yield* goal.get({ sessionID, id: created.id })
      expect(fetched?.content).toBe("交付 P1-4 goal 系统")

      const list = yield* goal.list({ sessionID })
      expect(list).toHaveLength(1)
      expect(list[0]?.id).toBe(created.id)

      const other = yield* newSession()
      expect(yield* goal.list({ sessionID: other })).toHaveLength(0)
    }),
  )

  it.instance("rejects empty content", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = yield* newSession()
      const exit = yield* goal
        .create({ sessionID, content: "   " })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("follows the full lifecycle with a done_reason audit trail", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = yield* newSession()
      const created = yield* goal.create({ sessionID, content: "重构状态机" })

      const inProgress = yield* goal.update({ sessionID, id: created.id, status: "in_progress" })
      expect(inProgress?.status).toBe("in_progress")

      const blocked = yield* goal.update({ sessionID, id: created.id, status: "blocked" })
      expect(blocked?.status).toBe("blocked")

      const reopened = yield* goal.update({ sessionID, id: created.id, status: "open" })
      expect(reopened?.status).toBe("open")

      const done = yield* goal.update({
        sessionID,
        id: created.id,
        status: "done",
        done_reason: "全部测试通过且 typecheck 绿",
      })
      expect(done?.status).toBe("done")
      expect(done?.done_reason).toBe("全部测试通过且 typecheck 绿")

      const statuses = yield* goal.list({ sessionID, status: "done" })
      expect(statuses).toHaveLength(1)
    }),
  )

  it.instance("rejects illegal status transitions", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = yield* newSession()
      const created = yield* goal.create({ sessionID, content: "目标" })

      const done = yield* goal.update({ sessionID, id: created.id, status: "done", done_reason: "完成" })
      expect(done?.status).toBe("done")

      const fromDone = yield* goal
        .update({ sessionID, id: created.id, status: "open" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(fromDone)).toBe(true)
      const fromDoneToCancelled = yield* goal
        .update({ sessionID, id: created.id, status: "cancelled" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(fromDoneToCancelled)).toBe(true)

      const cancelled = yield* goal.create({ sessionID, content: "目标2" })
      yield* goal.update({ sessionID, id: cancelled.id, status: "cancelled" })
      const fromCancelled = yield* goal
        .update({ sessionID, id: cancelled.id, status: "in_progress" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(fromCancelled)).toBe(true)
    }),
  )

  it.instance("requires done_reason before marking a goal done", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = yield* newSession()
      const created = yield* goal.create({ sessionID, content: "审计目标" })

      const missingReason = yield* goal
        .update({ sessionID, id: created.id, status: "done" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(missingReason)).toBe(true)

      const blankReason = yield* goal
        .update({ sessionID, id: created.id, status: "done", done_reason: "   " })
        .pipe(Effect.exit)
      expect(Exit.isFailure(blankReason)).toBe(true)

      const stillOpen = yield* goal.get({ sessionID, id: created.id })
      expect(stillOpen?.status).toBe("open")
    }),
  )

  it.instance("update edits content, priority, and deadline", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = yield* newSession()
      const created = yield* goal.create({ sessionID, content: "初版", priority: "low" })

      const updated = yield* goal.update({
        sessionID,
        id: created.id,
        content: "改版",
        priority: "high",
        deadline: 456,
      })
      expect(updated?.content).toBe("改版")
      expect(updated?.priority).toBe("high")
      expect(updated?.deadline).toBe(456)

      const missing = yield* goal.update({ sessionID, id: "goal_nope", content: "x" })
      expect(missing).toBeUndefined()
    }),
  )

  it.instance("update is scoped to the session owning the goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = yield* newSession()
      const other = yield* newSession()
      const created = yield* goal.create({ sessionID, content: "私有目标" })

      const result = yield* goal.update({ sessionID: other, id: created.id, status: "done" })
      expect(result).toBeUndefined()
    }),
  )
})

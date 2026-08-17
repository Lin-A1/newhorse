import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { SessionProjector } from "@newhorse/core/session/projector"
import { PermissionV1 } from "@newhorse/core/v1/permission"
import { FSUtil } from "@newhorse/core/fs-util"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Database } from "@newhorse/core/database/database"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Goal } from "@/session/goal"
import { Truncate } from "@/tool/truncate"
import { GoalTool } from "@/tool/goal"
import type * as Tool from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Goal.node,
      Database.node,
      Session.node,
      SessionProjector.node,
      Truncate.node,
      Agent.node,
      FSUtil.node,
    ]),
  ),
)

describe("tool.goal", () => {
  it.instance("creates, lists, and updates goals from a session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Goal tool test" })
      const asked: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []

      const info = yield* GoalTool
      const tool = yield* info.init()
      const ctx = {
        sessionID: session.id,
        messageID: MessageID.ascending(),
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (request) => Effect.sync(() => void asked.push(request)),
      } satisfies Tool.Context

      const created = yield* tool.execute({ action: "create", content: "交付 goal 工具" }, ctx)
      expect(created.title).toBe("Goal created")
      expect(created.output).toContain("交付 goal 工具")
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ permission: "goal" })

      const status = yield* tool.execute({ action: "status" }, ctx)
      expect(status.output).toContain("交付 goal 工具")
      expect(status.output).toContain("(open; medium)")

      const id = status.output.match(/\[(goal_\w+)\]/)?.[1]
      expect(id).toBeDefined()

      const done = yield* tool.execute(
        { action: "update", id, status: "done", done_reason: "端到端验证通过" },
        ctx,
      )
      expect(done.title).toBe("Goal updated")
      expect(done.output).toContain("done: 端到端验证通过")

      const after = yield* tool.execute({ action: "status" }, ctx)
      expect(after.output).toContain("(done; medium)")
    }),
  )

  it.instance("rejects marking done without a reason", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Goal audit test" })
      const info = yield* GoalTool
      const tool = yield* info.init()
      const ctx = {
        sessionID: session.id,
        messageID: MessageID.ascending(),
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context

      const created = yield* tool.execute({ action: "create", content: "审计目标" }, ctx)
      const id = created.output.match(/\[(goal_\w+)\]/)?.[1]
      expect(id).toBeDefined()

      const error = yield* tool
        .execute({ action: "update", id, status: "done" }, ctx)
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("done_reason")
    }),
  )
})

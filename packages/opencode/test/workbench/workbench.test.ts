import { describe, expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@newhorse/core/database/database"
import { Workbench } from "../../src/workbench"
import { testEffect } from "../lib/effect"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { TestInstance } from "../fixture/fixture"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const it = testEffect(
  LayerNode.compile(LayerNode.group([Workbench.node, Database.node]), [
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

describe("workbench todos", () => {
  it.instance("create, list, and scope todos by directory", () =>
    Effect.gen(function* () {
      const workbench = yield* Workbench.Service
      const dir = (yield* TestInstance).directory

      const created = yield* workbench.create({
        directory: dir,
        content: "写周报",
        priority: "high",
        deadline: 123,
      })
      expect(created.content).toBe("写周报")
      expect(created.status).toBe("open")
      expect(created.source).toBe("user")
      expect(created.id.startsWith("wbt_")).toBe(true)

      const list = yield* workbench.list({ directory: dir })
      expect(list).toHaveLength(1)
      expect(list[0]?.content).toBe("写周报")

      const other = yield* workbench.list({ directory: "G:\\other\\dir" })
      expect(other).toHaveLength(0)
    }),
  )

  it.instance("rejects empty content and invalid status transitions", () =>
    Effect.gen(function* () {
      const workbench = yield* Workbench.Service
      const dir = (yield* TestInstance).directory

      const empty = yield* workbench
        .create({ directory: dir, content: "   " })
        .pipe(Effect.exit)
      expect(Exit.isFailure(empty)).toBe(true)

      const created = yield* workbench.create({ directory: dir, content: "任务" })
      const bad = yield* workbench
        .update({ id: created.id, directory: dir, status: "done" })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(bad)).toBe(true)

      const reopen = yield* workbench
        .update({ id: created.id, directory: dir, status: "open" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(reopen)).toBe(true)
    }),
  )

  it.instance("update and remove follow the state machine", () =>
    Effect.gen(function* () {
      const workbench = yield* Workbench.Service
      const dir = (yield* TestInstance).directory
      const created = yield* workbench.create({ directory: dir, content: "回复邮件" })

      const inProgress = yield* workbench.update({ id: created.id, directory: dir, status: "in_progress" })
      expect(inProgress?.status).toBe("in_progress")

      const done = yield* workbench.update({ id: created.id, directory: dir, status: "done" })
      expect(done?.status).toBe("done")

      const removed = yield* workbench.remove({ id: created.id, directory: dir })
      expect(removed).toBe(true)
      expect(yield* workbench.remove({ id: created.id, directory: dir })).toBe(false)
      expect(yield* workbench.list({ directory: dir })).toHaveLength(0)
    }),
  )

  it.instance("newhorse source todos are retained for agent-created items", () =>
    Effect.gen(function* () {
      const workbench = yield* Workbench.Service
      const dir = (yield* TestInstance).directory
      const created = yield* workbench.create({
        directory: dir,
        content: "周三开会",
        source: "newhorse",
      })
      expect(created.source).toBe("newhorse")
    }),
  )
})

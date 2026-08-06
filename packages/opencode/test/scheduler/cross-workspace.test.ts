import { describe, expect } from "bun:test"
import { Database } from "@newhorse/core/database/database"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import { Effect } from "effect"
import { Scheduler } from "@/scheduler"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Scheduler.node, Database.node])))

describe("Scheduler cross-workspace scoping", () => {
  it.instance("a reminder in another workspace is not visible to list() but ticks deliver it globally", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const now = Date.now()
      yield* scheduler.create({
        workspaceID: WorkspaceV2.ID.make("wrk_other"),
        profileID: "assistant",
        title: "Cross workspace",
        body: "Should not appear in this instance's list",
        scheduleAt: now,
        timezone: "UTC",
      })
      // list() is scoped to the instance workspace + directory, so a reminder
      // pinned to a different workspace is invisible here.
      expect(yield* scheduler.list()).toHaveLength(0)
      // tick() claims across all workspaces, so it still fires.
      const delivered = yield* scheduler.tick(now)
      expect(delivered).toBe(1)
    }),
  )
})

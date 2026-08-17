import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import { FSUtil } from "@newhorse/core/fs-util"
import { Goal } from "@/session/goal"
import { InstanceState } from "@/effect/instance-state"
import { BoulderState } from "@/plan/boulder-state"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "update", "status", "list"]),
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["open", "in_progress", "blocked", "done", "cancelled"])),
  priority: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  deadline: Schema.optional(Schema.Number),
  done_reason: Schema.optional(Schema.String),
})

type Metadata = { count?: number }

function renderLine(item: Goal.Info) {
  const parts = [`[${item.id}]`, `(${item.status}; ${item.priority})`, item.content]
  if (item.deadline) parts.push(`due ${new Date(item.deadline).toISOString()}`)
  if (item.status === "done" && item.done_reason) parts.push(`done: ${item.done_reason}`)
  return parts.join(" ")
}

function render(items: Goal.Info[]) {
  if (items.length === 0) return "No goals."
  return items.map(renderLine).join("\n")
}

export const GoalTool = Tool.define<typeof Parameters, Metadata, Goal.Service | FSUtil.Service>(
  "goal",
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const fsys = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context

          if (params.action === "list") {
            const items = yield* goal.list({ sessionID: ctx.sessionID })
            return { title: `${items.length} goals`, metadata: { count: items.length }, output: render(items) }
          }

          if (params.action === "status") {
            if (params.id) {
              const item = yield* goal.get({ sessionID: ctx.sessionID, id: params.id })
              if (!item) return yield* Effect.fail(new Error(`Goal not found: ${params.id}`))
              return { title: "Goal status", metadata: {}, output: render([item]) }
            }
            const items = yield* goal.list({ sessionID: ctx.sessionID })
            return { title: `${items.length} goals`, metadata: { count: items.length }, output: render(items) }
          }

          if (params.action === "create") {
            if (!params.content?.trim()) return yield* Effect.fail(new Error("create requires content"))
            yield* ctx.ask({ permission: "goal", patterns: ["*"], always: ["*"], metadata: {} })
            const created = yield* goal.create({
              sessionID: ctx.sessionID,
              content: params.content,
              priority: params.priority,
              deadline: params.deadline,
            })
            yield* BoulderState.associateGoalId(fsys, instance, created.id)
            return { title: "Goal created", metadata: { count: 1 }, output: render([created]) }
          }

          if (params.action === "update") {
            if (!params.id) return yield* Effect.fail(new Error("update requires id"))
            yield* ctx.ask({ permission: "goal", patterns: ["*"], always: ["*"], metadata: {} })
            const updated = yield* goal.update({
              sessionID: ctx.sessionID,
              id: params.id,
              content: params.content,
              status: params.status,
              priority: params.priority,
              deadline: params.deadline,
              done_reason: params.done_reason,
            })
            if (!updated) return yield* Effect.fail(new Error(`Goal not found: ${params.id}`))
            return { title: "Goal updated", metadata: {}, output: render([updated]) }
          }

          return yield* Effect.fail(new Error(`Unknown action: ${params.action}`))
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

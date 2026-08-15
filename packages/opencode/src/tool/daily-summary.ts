import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./daily-summary.txt"
import { DailySummary } from "@/daily-summary"
import { Session } from "@/session/session"
import { PositiveInt } from "@newhorse/core/schema"

export const MAX_SUMMARIES = 30
const DEFAULT_LIMIT = 7

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["list", "generate"])).annotate({
    description: "Operation to perform: list recent daily summaries, or generate (propose/overwrite) one",
  }),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SUMMARIES))).annotate({
    description: "Number of daily summaries to return (default 7, max 30)",
  }),
  from: Schema.optional(Schema.Number).annotate({
    description: "Start of the summary creation-time range, inclusive, ms since epoch",
  }),
  to: Schema.optional(Schema.Number).annotate({
    description: "End of the summary creation-time range, exclusive, ms since epoch",
  }),
  date: Schema.optional(Schema.Number).annotate({
    description: "Target date for generate, ms since epoch (default today, local time)",
  }),
  overwrite: Schema.optional(Schema.Boolean).annotate({
    description:
      "generate: replace the existing summary for the target date. Without it an existing summary is left untouched",
  }),
})

type Metadata = {
  count: number
  profile?: string
  alreadyExists?: boolean
  overwritten?: boolean
}

function render(items: DailySummary.Info[]) {
  if (items.length === 0) return "暂无每日总结记录。"
  return items.map((item) => `${item.date}: ${item.content}`).join("\n\n")
}

export const DailySummaryTool = Tool.define<
  typeof Parameters,
  Metadata,
  DailySummary.Service | Session.Service
>(
  "daily-summary",
  Effect.gen(function* () {
    const dailySummary = yield* DailySummary.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(ctx.sessionID)

          if (params.action === "generate") {
            const date = params.date ?? Date.now()
            const existing = yield* dailySummary.get({ date })

            // A summary already exists and the model didn't ask to overwrite:
            // propose a fresh draft alongside the existing one and let the
            // model decide whether to persist the overwrite.
            if (existing !== undefined && !params.overwrite) {
              const generated = yield* dailySummary.draft({ date })
              if (generated === undefined) {
                return {
                  title: "Daily summary generation",
                  metadata: { count: 0, profile: session.profileID, alreadyExists: true },
                  output:
                    `当天（${existing.date}）已有一份每日总结，但没有读取到可重新总结的会话活动：\n${existing.content}`,
                }
              }
              return {
                title: "Daily summary generation",
                metadata: { count: 1, profile: session.profileID, alreadyExists: true },
                output:
                  `当天（${existing.date}）已有一份每日总结：\n${existing.content}\n\n` +
                  `重新生成的总结（尚未保存）：\n${generated}\n\n` +
                  `如果要用新总结覆盖已有总结，请再次调用本工具并传入 "overwrite": true。`,
              }
            }

            const generated = yield* dailySummary.generate({ date })
            if (generated === undefined) {
              return {
                title: "Daily summary generation",
                metadata: { count: 0, profile: session.profileID },
                output: "没有可总结的会话活动（未读取到 newhorse work / newhorse / Claude Code / Codex 会话）。",
              }
            }
            return {
              title: "Daily summary generation",
              metadata: {
                count: 1,
                profile: session.profileID,
                ...(existing !== undefined ? { overwritten: true } : {}),
              },
              output: generated,
            }
          }

          const items = yield* dailySummary.list({ from: params.from, to: params.to })
          const sliced = items.slice(0, params.limit ?? DEFAULT_LIMIT)
          return {
            title: `${sliced.length} daily summaries`,
            metadata: { count: sliced.length, profile: session.profileID },
            output: render(sliced),
          }
        }),
    }
  }),
)

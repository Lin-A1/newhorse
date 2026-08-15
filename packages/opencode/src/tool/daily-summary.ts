import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./daily-summary.txt"
import { DailySummary } from "@/daily-summary"
import { Session } from "@/session/session"
import { PositiveInt } from "@newhorse/core/schema"

export const MAX_SUMMARIES = 30
const DEFAULT_LIMIT = 7

export const Parameters = Schema.Struct({
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SUMMARIES))).annotate({
    description: "Number of daily summaries to return (default 7, max 30)",
  }),
  from: Schema.optional(Schema.Number).annotate({
    description: "Start of the summary creation-time range, inclusive, ms since epoch",
  }),
  to: Schema.optional(Schema.Number).annotate({
    description: "End of the summary creation-time range, exclusive, ms since epoch",
  }),
})

type Metadata = {
  count: number
  profile?: string
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

import { DailySummary } from "@/daily-summary"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const dailySummaryHandlers = HttpApiBuilder.group(InstanceHttpApi, "daily-summary", (handlers) =>
  Effect.gen(function* () {
    const service = yield* DailySummary.Service
    return handlers
      .handle("list", (ctx) => service.list({ from: ctx.query.from, to: ctx.query.to }))
      .handle("generate", (ctx) => service.generate({ date: ctx.payload?.date }).pipe(Effect.map((v) => v ?? null)))
  }),
)

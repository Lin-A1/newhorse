import { DailySummary } from "@/daily-summary"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

const root = "/daily-summary"

const ListQuery = Schema.Struct({
  from: Schema.optional(Schema.Number),
  to: Schema.optional(Schema.Number),
})

const GeneratePayload = Schema.Struct({
  date: Schema.optional(Schema.Number),
})

export const DailySummaryApi = HttpApi.make("daily-summary").add(
  HttpApiGroup.make("daily-summary")
    .add(
      HttpApiEndpoint.get("list", root, {
        query: ListQuery,
        success: described(Schema.Array(DailySummary.Report), "Daily activity reports"),
      }).annotateMerge(OpenApi.annotations({ identifier: "daily-summary.list", summary: "List daily reports" })),
      HttpApiEndpoint.post("generate", `${root}/generate`, {
        payload: Schema.optional(GeneratePayload),
        success: described(Schema.NullOr(DailySummary.Report), "Generated daily report"),
      }).annotateMerge(OpenApi.annotations({ identifier: "daily-summary.generate", summary: "Generate daily report" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "daily-summary", description: "Daily activity reports." }))
    .middleware(Authorization),
)

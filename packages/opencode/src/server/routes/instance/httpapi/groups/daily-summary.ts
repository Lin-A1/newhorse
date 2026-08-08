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
        success: described(Schema.Array(DailySummary.Info), "Daily activity summaries"),
      }).annotateMerge(OpenApi.annotations({ identifier: "daily-summary.list", summary: "List daily summaries" })),
      HttpApiEndpoint.post("generate", `${root}/generate`, {
        payload: Schema.optional(GeneratePayload),
        success: described(Schema.NullOr(Schema.String), "Generated daily summary text"),
      }).annotateMerge(OpenApi.annotations({ identifier: "daily-summary.generate", summary: "Generate daily summary" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "daily-summary", description: "Daily activity summaries." }))
    .middleware(Authorization),
)

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PolicyAuditStore } from "@/trust-policy/policy-audit"

export const policyAuditHandlers = HttpApiBuilder.group(InstanceHttpApi, "policy-audit", (handlers) =>
  Effect.gen(function* () {
    const audits = yield* PolicyAuditStore.Service

    return handlers.handle("list", (ctx) =>
      Effect.gen(function* () {
        return yield* audits.page({
          limit: ctx.query.limit,
          cursor: ctx.query.cursor,
        })
      }),
    )
  }),
)

import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { PolicyAuditTable } from "@newhorse/core/trust-policy/sql"
import { desc, lt } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import type { WorkspacePolicy } from "@/control-plane/workspace-policy"

export const Decision = Schema.Literals(["allow", "ask", "deny"])
export type Decision = Schema.Schema.Type<typeof Decision>

export const Reason = Schema.Literals([
  "same_scope",
  "user_global_preference_only",
  "relationship_personal_only",
  "project_to_personal_requires_grant",
  "personal_to_project_requires_grant",
  "extension_personal_opt_in_required",
  "workspace_policy",
])
export type Reason = Schema.Schema.Type<typeof Reason>

export const Action = Schema.Literals([
  "memory.save",
  "memory.retrieve",
  "memory.propose",
  "continuity.propose",
  "continuity.approve",
  "continuity.inject",
  "continuity.revoke",
  "reminder.create",
  "reminder.deliver",
  "extension.load",
  "tool.load",
  "skill.load",
  "mcp.connect",
  "capability.explain",
])
export type Action = Schema.Schema.Type<typeof Action>

export const ContentScopeSchema = Schema.Literals(["project", "personal", "user_global", "relationship"])
export type ContentScopeSchema = Schema.Schema.Type<typeof ContentScopeSchema>

export type ContentScope = WorkspacePolicy.Kind | "user_global" | "relationship"

/**
 * Content-free policy audit record. It never carries Memory content, Reminder
 * bodies, Continuity purpose/summary, prompt text, file paths, headers, env, or
 * secrets. `actor` is a minimal, opaque identifier only.
 */
export const PolicyAudit = Schema.Struct({
  id: Schema.String,
  time: Schema.Number,
  action: Action,
  source: ContentScopeSchema,
  destination: ContentScopeSchema,
  decision: Decision,
  reason: Reason,
  actor: Schema.String,
}).annotate({ identifier: "PolicyAudit" })
export type PolicyAudit = Schema.Schema.Type<typeof PolicyAudit>

export const Page = Schema.Struct({
  items: Schema.Array(PolicyAudit),
  nextCursor: Schema.optional(Schema.String),
}).annotate({ identifier: "PolicyAuditPage" })
export type Page = Schema.Schema.Type<typeof Page>

export interface Interface {
  readonly record: (input: PolicyAudit) => Effect.Effect<void>
  readonly page: (input?: { limit?: number; cursor?: string }) => Effect.Effect<Page>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/PolicyAudit") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const record: Interface["record"] = Effect.fn("PolicyAudit.record")(function* (input) {
      yield* db
        .insert(PolicyAuditTable)
        .values({
          id: input.id,
          time: input.time,
          action: input.action,
          source: input.source,
          destination: input.destination,
          decision: input.decision,
          reason: input.reason,
          actor: input.actor,
        })
        .run()
        .pipe(Effect.orDie)
    })

    const page: Interface["page"] = Effect.fn("PolicyAudit.page")(function* (input) {
      const limit = Math.min(Math.max(input?.limit ?? 50, 1), 100)
      const rows = yield* db
        .select()
        .from(PolicyAuditTable)
        .where(input?.cursor ? lt(PolicyAuditTable.id, input.cursor) : undefined)
        .orderBy(desc(PolicyAuditTable.time), desc(PolicyAuditTable.id))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const more = rows.length > limit
      const items = rows.slice(0, limit).map((row): PolicyAudit => ({
        id: row.id,
        time: row.time,
        action: row.action,
        source: row.source,
        destination: row.destination,
        decision: row.decision,
        reason: row.reason,
        actor: row.actor,
      }))
      return { items, ...(more ? { nextCursor: items.at(-1)?.id } : {}) }
    })

    return Service.of({ record, page })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as PolicyAuditStore from "./policy-audit"

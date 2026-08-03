import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { MemoryTable } from "@newhorse/core/memory/sql"
import { MessageTable, SessionTable } from "@newhorse/core/session/sql"
import type {
  MemoryKind,
  MemoryProvenance,
  MemoryScope,
  MemorySensitivity,
  MemoryStatus,
} from "@newhorse/core/memory/sql"
import type { WorkspaceV2 } from "@newhorse/core/workspace"
import type { MessageID } from "@newhorse/core/v1/session"
import type { SessionSchema } from "@newhorse/core/session/schema"
import { Identifier } from "@newhorse/core/id/id"
import { InstanceState } from "@/effect/instance-state"
import { WorkspacePolicy } from "@/control-plane/workspace-policy"
import type { PermissionV1 } from "@newhorse/core/v1/permission"
import { TrustPolicy } from "@/trust-policy"
import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"

export const Scope = Schema.Literals(["workspace", "user_global"])
export const Kind = Schema.Literals(["preference", "fact", "goal", "event", "relationship", "summary"])
export const Provenance = Schema.Literals(["user_explicit", "user_confirmed", "model_inferred"])
export const Sensitivity = Schema.Literals(["normal", "sensitive"])
export const Status = Schema.Literals(["proposed", "active", "paused", "rejected", "deleted"])

export const Info = Schema.Struct({
  id: Schema.String,
  workspaceID: Schema.optional(Schema.String),
  profileID: Schema.optional(Schema.String),
  scope: Scope,
  kind: Kind,
  content: Schema.String,
  sourceSessionID: Schema.optional(Schema.String),
  sourceMessageID: Schema.optional(Schema.String),
  provenance: Provenance,
  sensitivity: Sensitivity,
  status: Status,
  confidence: Schema.optional(Schema.Number),
  timeCreated: Schema.Int,
  timeUpdated: Schema.Int,
  timeExpires: Schema.optional(Schema.Int),
}).annotate({ identifier: "MemoryInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Page = Schema.Struct({
  items: Schema.Array(Info),
  nextCursor: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryPage" })
export type Page = Schema.Schema.Type<typeof Page>

export interface SaveInput {
  scope?: MemoryScope
  kind: MemoryKind
  content: string
  provenance: MemoryProvenance
  sensitivity?: MemorySensitivity
  confidence?: number
  sourceSessionID?: SessionSchema.ID
  sourceMessageID?: MessageID
  profileID?: string
  expiresAt?: number
  /** User permission ruleset for content-flow tightening (optional). */
  userRuleset?: PermissionV1.Ruleset
}

export interface QueryInput {
  status?: MemoryStatus[]
  includeGlobal?: boolean
  profileID?: string
  limit?: number
  cursor?: string
}

export interface UpdateInput {
  id: string
  scope?: MemoryScope
  kind?: MemoryKind
  content?: string
  expiresAt?: number | null
  profileID?: string
  /** User permission ruleset for content-flow tightening (optional). */
  userRuleset?: PermissionV1.Ruleset
}

export class SensitiveMemoryRejected extends Schema.TaggedErrorClass<SensitiveMemoryRejected>()(
  "SensitiveMemoryRejected",
  { message: Schema.String },
) {
  constructor() {
    super({ message: "Sensitive memory cannot be stored until encryption at rest is available" })
  }
}

export class MemoryPolicyRejected extends Schema.TaggedErrorClass<MemoryPolicyRejected>()("MemoryPolicyRejected", {
  reason: Schema.Literals([
    "global_preference_only",
    "relationship_personal_only",
    "profile_required",
    "empty_content",
    "workspace_policy",
    "source_scope_mismatch",
    "source_message_mismatch",
  ]),
  message: Schema.String,
}) {}

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{17}[\dXx]\b/,
  /\b(?:ssn|social security(?: number)?|passport(?: number)?|driver'?s license|national id|government id)\b\s*[:=#-]\s*[A-Za-z0-9-]{4,}\b/i,
  /\b(?:home address|street address|exact location|gps|latitude|longitude)\b\s*[:=]\s*[^\n]+/i,
  /\b(?:diagnos(?:is|ed with)|medical record|health condition|prescription|blood type|allerg(?:y|ic to))\b\s*[:=]?\s*[^\n]+/i,
  /\b(?:password|passwd|secret|api[_-]?key|token|credential)\b\s*[:=]/i,
]

export function detectSensitive(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))
}

const DEFAULT_STATUSES: MemoryStatus[] = ["proposed", "active", "paused"]

export interface Interface {
  readonly save: (input: SaveInput) => Effect.Effect<Info, SensitiveMemoryRejected | MemoryPolicyRejected>
  readonly page: (input?: QueryInput) => Effect.Effect<Page>
  readonly list: (input?: QueryInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly count: (input?: QueryInput) => Effect.Effect<number>
  readonly retrieve: (input?: {
    limit?: number
    profileID?: string
    relationshipOnly?: boolean
    userRuleset?: PermissionV1.Ruleset
  }) => Effect.Effect<ReadonlyArray<Info>>
  readonly update: (
    input: UpdateInput,
  ) => Effect.Effect<Info | undefined, SensitiveMemoryRejected | MemoryPolicyRejected>
  readonly decide: (input: {
    id: string
    scope?: MemoryScope
    decision: "accept" | "reject"
    profileID?: string
  }) => Effect.Effect<Info | undefined>
  readonly pause: (input: {
    id: string
    scope?: MemoryScope
    paused: boolean
    profileID?: string
  }) => Effect.Effect<Info | undefined>
  readonly forget: (id: string, scope?: MemoryScope, profileID?: string) => Effect.Effect<boolean>
  readonly clear: (input?: {
    target?: "workspace" | "relationship" | "user_global"
    profileID?: string
  }) => Effect.Effect<number, MemoryPolicyRejected>
  readonly export: (input?: { includeGlobal?: boolean; profileID?: string }) => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Memory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const trustPolicy = yield* TrustPolicy.Service

    const decode = (row: typeof MemoryTable.$inferSelect): Info => ({
      id: row.id,
      workspaceID: row.workspace_id ?? undefined,
      profileID: row.profile_id ?? undefined,
      scope: row.scope,
      kind: row.kind,
      content: row.content,
      sourceSessionID: row.source_session_id ?? undefined,
      sourceMessageID: row.source_message_id ?? undefined,
      provenance: row.provenance,
      sensitivity: row.sensitivity,
      status: row.status,
      confidence: row.confidence ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      timeExpires: row.time_expires ?? undefined,
    })

    const context = Effect.gen(function* () {
      const instance = yield* InstanceState.context
      return {
        workspaceID: yield* InstanceState.workspaceID,
        directory: instance.directory,
        policy: yield* WorkspacePolicy.current,
      }
    })

    const globalFilter = and(
      eq(MemoryTable.scope, "user_global"),
      isNull(MemoryTable.workspace_id),
      isNull(MemoryTable.directory),
    )

    const workspaceFilter = (owner: { workspaceID?: WorkspaceV2.ID; directory: string }) =>
      owner.workspaceID
        ? and(eq(MemoryTable.scope, "workspace"), eq(MemoryTable.workspace_id, owner.workspaceID))
        : and(
            eq(MemoryTable.scope, "workspace"),
            isNull(MemoryTable.workspace_id),
            eq(MemoryTable.directory, owner.directory),
          )

    const ownerFilter = (scope: MemoryScope, owner: { workspaceID?: WorkspaceV2.ID; directory: string }) =>
      scope === "user_global" ? globalFilter : workspaceFilter(owner)

    const visibleFilter = (owner: { workspaceID?: WorkspaceV2.ID; directory: string }, includeGlobal: boolean) =>
      includeGlobal ? or(workspaceFilter(owner), globalFilter) : workspaceFilter(owner)

    const relationshipProfileFilter = (profileID?: string) =>
      profileID
        ? or(ne(MemoryTable.kind, "relationship"), eq(MemoryTable.profile_id, profileID))!
        : ne(MemoryTable.kind, "relationship")

    const mutationFilter = (
      scope: MemoryScope,
      owner: { workspaceID?: WorkspaceV2.ID; directory: string },
      profileID?: string,
    ) =>
      scope === "workspace"
        ? and(ownerFilter(scope, owner), relationshipProfileFilter(profileID))
        : ownerFilter(scope, owner)

    const validate = Effect.fn("Memory.validate")(function* (input: {
      scope: MemoryScope
      kind: MemoryKind
      content: string
      profileID?: string
      policy: WorkspacePolicy.Info
      sensitivity?: MemorySensitivity
      userRuleset?: PermissionV1.Ruleset
    }) {
      if (!input.content.trim()) {
        return yield* new MemoryPolicyRejected({ reason: "empty_content", message: "Memory content cannot be empty" })
      }
      if (input.sensitivity === "sensitive" || detectSensitive(input.content)) {
        return yield* new SensitiveMemoryRejected()
      }
      // Content-flow is decided by the central TrustPolicy matrix using only
      // trusted Workspace metadata and the memory scope/kind. The destination
      // scope is derived here, never accepted from the caller as authority.
      const destination: TrustPolicy.ContentScope =
        input.scope === "user_global"
          ? "user_global"
          : input.kind === "relationship"
            ? "relationship"
            : input.policy.contentScope
      const flow = yield* trustPolicy.decide({
        action: "memory.save",
        source: input.policy.contentScope,
        destination,
        kind: input.kind,
        userRuleset: input.userRuleset,
        actor: input.profileID ?? "memory",
      })
      if (flow.decision !== "allow") {
        const reason =
          flow.reason === "user_global_preference_only"
            ? "global_preference_only"
            : flow.reason === "relationship_personal_only"
              ? "relationship_personal_only"
              : "workspace_policy"
        return yield* new MemoryPolicyRejected({
          reason,
          message: "Memory save is not permitted by the content-flow policy",
        })
      }
      if (input.kind === "relationship" && !input.profileID) {
        return yield* new MemoryPolicyRejected({
          reason: "profile_required",
          message: "Relationship memory requires a profile",
        })
      }
    })

    const resolveSource = Effect.fn("Memory.resolveSource")(function* (
      input: SaveInput,
      owner: { workspaceID?: WorkspaceV2.ID; directory: string },
    ) {
      if (input.sourceMessageID && !input.sourceSessionID) {
        return yield* new MemoryPolicyRejected({
          reason: "source_message_mismatch",
          message: "Memory source message requires a source session",
        })
      }
      if (!input.sourceSessionID) return input.profileID
      const row = yield* db
        .select({
          profileID: SessionTable.profile_id,
          workspaceID: SessionTable.workspace_id,
          directory: SessionTable.directory,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sourceSessionID))
        .get()
        .pipe(Effect.orDie)
      const matches = owner.workspaceID
        ? row?.workspaceID === owner.workspaceID
        : !row?.workspaceID && row?.directory === owner.directory
      if (!matches || (input.profileID && row?.profileID !== input.profileID)) {
        return yield* new MemoryPolicyRejected({
          reason: "source_scope_mismatch",
          message: "Memory source session does not belong to the current Workspace/Profile",
        })
      }
      if (input.sourceMessageID) {
        const message = yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(and(eq(MessageTable.id, input.sourceMessageID), eq(MessageTable.session_id, input.sourceSessionID)))
          .get()
          .pipe(Effect.orDie)
        if (!message) {
          return yield* new MemoryPolicyRejected({
            reason: "source_message_mismatch",
            message: "Memory source message does not belong to the source session",
          })
        }
      }
      return row?.profileID ?? input.profileID
    })

    const save: Interface["save"] = Effect.fn("Memory.save")(function* (input) {
      const owner = yield* context
      const scope = input.scope ?? "workspace"
      const profileID = yield* resolveSource(input, owner)
      yield* validate({
        scope,
        kind: input.kind,
        content: input.content,
        profileID,
        policy: owner.policy,
        sensitivity: input.sensitivity,
        userRuleset: input.userRuleset,
      })

      const now = Date.now()
      const row = {
        id: Identifier.ascending("memory"),
        workspace_id: scope === "user_global" ? null : (owner.workspaceID ?? null),
        directory: scope === "user_global" || owner.workspaceID ? null : owner.directory,
        scope,
        profile_id: scope === "user_global" ? null : (profileID ?? null),
        kind: input.kind,
        content: input.content.trim(),
        source_session_id: input.sourceSessionID ?? null,
        source_message_id: input.sourceMessageID ?? null,
        provenance: input.provenance,
        confidence: input.confidence ?? null,
        sensitivity: "normal" as const,
        status: input.provenance === "model_inferred" ? ("proposed" as const) : ("active" as const),
        time_created: now,
        time_updated: now,
        time_expires: input.expiresAt ?? null,
      }
      const saved = yield* db.insert(MemoryTable).values(row).returning().get().pipe(Effect.orDie)
      return decode(saved!)
    })

    const filters = Effect.fn("Memory.filters")(function* (input?: QueryInput) {
      const owner = yield* context
      const conditions = [
        visibleFilter(owner, input?.includeGlobal ?? true),
        inArray(MemoryTable.status, input?.status ?? DEFAULT_STATUSES),
      ]
      if (owner.policy.contentScope !== "personal") conditions.push(ne(MemoryTable.kind, "relationship"))
      else conditions.push(relationshipProfileFilter(input?.profileID))
      if (input?.profileID) {
        conditions.push(or(eq(MemoryTable.scope, "user_global"), eq(MemoryTable.profile_id, input.profileID))!)
      }
      if (input?.cursor) conditions.push(lt(MemoryTable.id, input.cursor))
      return and(...conditions)
    })

    const page: Interface["page"] = Effect.fn("Memory.page")(function* (input) {
      const limit = Math.min(Math.max(input?.limit ?? 50, 1), 100)
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(yield* filters(input))
        .orderBy(desc(MemoryTable.id))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const more = rows.length > limit
      const items = rows.slice(0, limit).map(decode)
      return { items, ...(more ? { nextCursor: items.at(-1)?.id } : {}) }
    })

    const list: Interface["list"] = Effect.fn("Memory.list")(function* (input) {
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(yield* filters(input))
        .orderBy(desc(MemoryTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    const count: Interface["count"] = Effect.fn("Memory.count")(function* (input) {
      const row = yield* db
        .select({ count: sql<number>`count(*)` })
        .from(MemoryTable)
        .where(yield* filters({ ...input, cursor: undefined }))
        .get()
        .pipe(Effect.orDie)
      return row?.count ?? 0
    })

    const retrieve: Interface["retrieve"] = Effect.fn("Memory.retrieve")(function* (input) {
      const owner = yield* context
      if (input?.relationshipOnly && (owner.policy.contentScope !== "personal" || !input.profileID)) return []
      const destination: TrustPolicy.ContentScope = input?.relationshipOnly
        ? "relationship"
        : owner.policy.contentScope
      const flow = yield* trustPolicy.decide({
        action: "memory.retrieve",
        source: owner.policy.contentScope,
        destination,
        userRuleset: input?.userRuleset,
        actor: input?.profileID ?? "memory",
      })
      if (flow.decision === "deny") return []
      const conditions = [
        visibleFilter(owner, !input?.relationshipOnly),
        eq(MemoryTable.status, "active"),
        or(isNull(MemoryTable.time_expires), gt(MemoryTable.time_expires, Date.now())),
      ]
      if (input?.relationshipOnly) {
        conditions.push(eq(MemoryTable.kind, "relationship"), eq(MemoryTable.profile_id, input.profileID!))
      } else {
        conditions.push(relationshipProfileFilter(input?.profileID))
        if (input?.profileID) {
          conditions.push(or(eq(MemoryTable.scope, "user_global"), eq(MemoryTable.profile_id, input.profileID))!)
        }
      }
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(and(...conditions))
        .orderBy(desc(MemoryTable.id))
        .limit(Math.min(Math.max(input?.limit ?? 20, 1), 100))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    const update: Interface["update"] = Effect.fn("Memory.update")(function* (input) {
      const owner = yield* context
      const scope = input.scope ?? "workspace"
      const current = yield* db
        .select()
        .from(MemoryTable)
        .where(and(eq(MemoryTable.id, input.id), mutationFilter(scope, owner, input.profileID)))
        .get()
        .pipe(Effect.orDie)
      if (!current) return undefined
      const kind = input.kind ?? current.kind
      if (kind === "relationship" && (!input.profileID || current.profile_id !== input.profileID)) return undefined
      const content = input.content ?? current.content
      yield* validate({
        scope,
        kind,
        content,
        profileID: current.profile_id ?? undefined,
        policy: owner.policy,
        sensitivity: current.sensitivity,
        userRuleset: input.userRuleset,
      })
      const row = yield* db
        .update(MemoryTable)
        .set({
          kind,
          content: content.trim(),
          ...(input.expiresAt !== undefined ? { time_expires: input.expiresAt } : {}),
          time_updated: Date.now(),
        })
        .where(and(eq(MemoryTable.id, input.id), mutationFilter(scope, owner, input.profileID)))
        .returning()
        .get()
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })

    const decide: Interface["decide"] = Effect.fn("Memory.decide")(function* (input) {
      const owner = yield* context
      const scope = input.scope ?? "workspace"
      const row = yield* db
        .update(MemoryTable)
        .set({
          status: input.decision === "accept" ? "active" : "rejected",
          ...(input.decision === "accept" ? { provenance: "user_confirmed" as const } : {}),
          time_updated: Date.now(),
        })
        .where(
          and(
            eq(MemoryTable.id, input.id),
            mutationFilter(scope, owner, input.profileID),
            eq(MemoryTable.status, "proposed"),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })

    const pause: Interface["pause"] = Effect.fn("Memory.pause")(function* (input) {
      const owner = yield* context
      const scope = input.scope ?? "workspace"
      const row = yield* db
        .update(MemoryTable)
        .set({ status: input.paused ? "paused" : "active", time_updated: Date.now() })
        .where(
          and(
            eq(MemoryTable.id, input.id),
            mutationFilter(scope, owner, input.profileID),
            eq(MemoryTable.status, input.paused ? "active" : "paused"),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })

    const forget: Interface["forget"] = Effect.fn("Memory.forget")(function* (id, scope = "workspace", profileID) {
      const owner = yield* context
      const row = yield* db
        .delete(MemoryTable)
        .where(and(eq(MemoryTable.id, id), mutationFilter(scope, owner, profileID)))
        .returning({ id: MemoryTable.id })
        .get()
        .pipe(Effect.orDie)
      return !!row
    })

    const clear: Interface["clear"] = Effect.fn("Memory.clear")(function* (input) {
      const owner = yield* context
      const target = input?.target ?? "workspace"
      let condition = workspaceFilter(owner)
      if (target === "user_global") condition = globalFilter
      if (target === "relationship") {
        if (owner.policy.contentScope !== "personal") {
          return yield* new MemoryPolicyRejected({
            reason: "relationship_personal_only",
            message: "Relationship memory is restricted to Personal workspaces",
          })
        }
        if (!input?.profileID) {
          return yield* new MemoryPolicyRejected({
            reason: "profile_required",
            message: "Relationship memory requires a trusted Profile",
          })
        }
        condition = and(
          workspaceFilter(owner),
          eq(MemoryTable.kind, "relationship"),
          eq(MemoryTable.profile_id, input.profileID),
        )!
      }
      return yield* db
        .transaction(
          Effect.fnUntraced(function* (tx) {
            const row = yield* tx
              .select({ count: sql<number>`count(*)` })
              .from(MemoryTable)
              .where(condition)
              .get()
            yield* tx.delete(MemoryTable).where(condition).run()
            return row?.count ?? 0
          }),
        )
        .pipe(Effect.orDie)
    })

    const exportRecords: Interface["export"] = Effect.fn("Memory.export")(function* (input) {
      const owner = yield* context
      const conditions = [visibleFilter(owner, input?.includeGlobal ?? true), ne(MemoryTable.status, "deleted")]
      if (owner.policy.contentScope !== "personal") conditions.push(ne(MemoryTable.kind, "relationship"))
      else conditions.push(relationshipProfileFilter(input?.profileID))
      if (input?.profileID) {
        conditions.push(or(eq(MemoryTable.scope, "user_global"), eq(MemoryTable.profile_id, input.profileID))!)
      }
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(and(...conditions))
        .orderBy(desc(MemoryTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    return Service.of({
      save,
      page,
      list,
      count,
      retrieve,
      update,
      decide,
      pause,
      forget,
      clear,
      export: exportRecords,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, TrustPolicy.node],
})

export * as Memory from "./index"

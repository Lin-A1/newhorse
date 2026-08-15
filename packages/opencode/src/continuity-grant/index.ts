import { Database } from "@newhorse/core/database/database"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Identifier } from "@newhorse/core/id/id"
import {
  ContinuityGrantAuditTable,
  ContinuityGrantTable,
  type ContinuityGrantAuditAction,
} from "@newhorse/core/continuity-grant/sql"
import { SessionTable } from "@newhorse/core/session/sql"
import type { SessionSchema } from "@newhorse/core/session/schema"
import { WorkspaceTable } from "@newhorse/core/control-plane/workspace.sql"
import type { WorkspaceV2 } from "@newhorse/core/workspace"
import { and, asc, eq, gt } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Profile } from "@/profile"
import { TrustPolicy } from "@/trust-policy"
import { WorkspacePolicy } from "@/control-plane/workspace-policy"

export const ID = Schema.String.pipe(Schema.brand("ContinuityGrant.ID"))
export type ID = Schema.Schema.Type<typeof ID>

export const Status = Schema.Literals(["proposed", "active", "revoked"])
export type Status = Schema.Schema.Type<typeof Status>

export const AuditAction = Schema.Literals(["proposed", "approved", "injected", "revoked"])
export type AuditAction = Schema.Schema.Type<typeof AuditAction>

export const Info = Schema.Struct({
  id: ID,
  sourceWorkspaceID: Schema.optional(Schema.String),
  sourceDirectory: Schema.String,
  sourceProfileID: Schema.String,
  sourceSessionID: Schema.String,
  destinationWorkspaceID: Schema.String,
  destinationDirectory: Schema.String,
  destinationProfileID: Schema.String,
  destinationSessionID: Schema.String,
  purpose: Schema.String,
  summary: Schema.String,
  relationshipPersistence: Schema.Boolean,
  timeExpires: Schema.Int,
  status: Status,
  timeApproved: Schema.optional(Schema.Int),
  timeRevoked: Schema.optional(Schema.Int),
  timeCreated: Schema.Int,
  timeUpdated: Schema.Int,
})
export type Info = Schema.Schema.Type<typeof Info>

export const AuditInfo = Schema.Struct({
  id: Schema.String,
  grantID: ID,
  action: AuditAction,
  outcome: Schema.String,
  reason: Schema.optional(Schema.String),
  destinationSessionID: Schema.optional(Schema.String),
  timeCreated: Schema.Int,
})
export type AuditInfo = Schema.Schema.Type<typeof AuditInfo>

export const PromptContext = Schema.Struct({
  purpose: Schema.String,
  summary: Schema.String,
})
export type PromptContext = Schema.Schema.Type<typeof PromptContext>

export class Rejected extends Schema.TaggedErrorClass<Rejected>()("ContinuityGrant.Rejected", {
  reason: Schema.String,
  message: Schema.String,
}) {}

export class InvalidState extends Schema.TaggedErrorClass<InvalidState>()("ContinuityGrant.InvalidState", {
  id: ID,
  status: Status,
  message: Schema.String,
}) {}

export interface ProposeInput {
  sourceSessionID: SessionSchema.ID
  destinationSessionID: SessionSchema.ID
  purpose: string
  summary: string
  timeExpires: number
}

export interface SourceInput {
  sourceSessionID: SessionSchema.ID
  id: ID
}

export interface PromptInput {
  destinationSessionID: SessionSchema.ID
  destinationWorkspaceID: WorkspaceV2.ID
  destinationProfileID: string
  destinationDirectory: string
  now?: number
}

export interface Interface {
  readonly propose: (input: ProposeInput) => Effect.Effect<Info, Rejected>
  readonly approve: (input: SourceInput) => Effect.Effect<Info | undefined, InvalidState>
  readonly listSource: (sourceSessionID: SessionSchema.ID) => Effect.Effect<Info[]>
  readonly getSource: (input: SourceInput) => Effect.Effect<Info | undefined>
  readonly auditSource: (input: SourceInput) => Effect.Effect<AuditInfo[] | undefined>
  readonly revokeSource: (input: SourceInput) => Effect.Effect<Info | undefined>
  readonly takeForPrompt: (input: PromptInput) => Effect.Effect<PromptContext[]>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/ContinuityGrant") {}

export const PURPOSE_MAX = 500
export const SUMMARY_MAX = 4_000
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u

type GrantRow = typeof ContinuityGrantTable.$inferSelect

type ProposeResult = { type: "error"; error: Rejected } | { type: "row"; row: GrantRow }
type ApproveResult = { type: "missing" } | { type: "error"; error: InvalidState } | { type: "row"; row: GrantRow }

function decode(row: GrantRow): Info {
  return {
    id: ID.make(row.id),
    sourceWorkspaceID: row.source_workspace_id ?? undefined,
    sourceDirectory: row.source_directory,
    sourceProfileID: row.source_profile_id,
    sourceSessionID: row.source_session_id,
    destinationWorkspaceID: row.destination_workspace_id,
    destinationDirectory: row.destination_directory,
    destinationProfileID: row.destination_profile_id,
    destinationSessionID: row.destination_session_id,
    purpose: row.purpose,
    summary: row.summary,
    relationshipPersistence: row.relationship_persistence,
    timeExpires: row.time_expires,
    status: row.status,
    timeApproved: row.time_approved ?? undefined,
    timeRevoked: row.time_revoked ?? undefined,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

function decodeAudit(row: typeof ContinuityGrantAuditTable.$inferSelect): AuditInfo {
  return {
    id: row.id,
    grantID: ID.make(row.grant_id),
    action: row.action,
    outcome: row.outcome,
    reason: row.reason ?? undefined,
    destinationSessionID: row.destination_session_id ?? undefined,
    timeCreated: row.time_created,
  }
}

function validateText(value: string, field: "purpose" | "summary", max: number): string | Rejected {
  const normalized = value.trim()
  if (!normalized)
    return new Rejected({ reason: `${field}_required`, message: `Continuity grant ${field} is required` })
  if (CONTROL_CHARACTER.test(normalized))
    return new Rejected({ reason: `${field}_control_character`, message: `Continuity grant ${field} is invalid` })
  if (normalized.length > max)
    return new Rejected({ reason: `${field}_too_long`, message: `Continuity grant ${field} is too long` })
  return normalized
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const profiles = yield* Profile.Service
    const trustPolicy = yield* TrustPolicy.Service

    const auditValues = (
      grantID: string,
      action: ContinuityGrantAuditAction,
      now: number,
      destinationSessionID?: SessionSchema.ID,
    ) => ({
      id: Identifier.ascending("continuityGrantAudit"),
      grant_id: grantID,
      action,
      outcome: "success",
      reason: null,
      destination_session_id: destinationSessionID ?? null,
      time_created: now,
    })

    const propose = Effect.fn("ContinuityGrant.propose")(function* (input: ProposeInput) {
      const purpose = validateText(input.purpose, "purpose", PURPOSE_MAX)
      if (purpose instanceof Rejected) return yield* purpose
      const summary = validateText(input.summary, "summary", SUMMARY_MAX)
      if (summary instanceof Rejected) return yield* summary
      const now = Date.now()
      if (!Number.isSafeInteger(input.timeExpires) || input.timeExpires <= now) {
        return yield* new Rejected({
          reason: "expiry_not_future",
          message: "Continuity grant expiry must be in the future",
        })
      }
      if (input.timeExpires - now > MAX_LIFETIME_MS) {
        return yield* new Rejected({
          reason: "expiry_too_far",
          message: "Continuity grant expiry cannot exceed 30 days",
        })
      }

      const result: ProposeResult = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const source = yield* tx
                .select({
                  id: SessionTable.id,
                  workspaceID: SessionTable.workspace_id,
                  profileID: SessionTable.profile_id,
                  directory: SessionTable.directory,
                })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.sourceSessionID))
                .get()
              const destination = yield* tx
                .select({
                  id: SessionTable.id,
                  workspaceID: SessionTable.workspace_id,
                  profileID: SessionTable.profile_id,
                  directory: SessionTable.directory,
                })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.destinationSessionID))
                .get()
              if (!source)
                return {
                  type: "error" as const,
                  error: new Rejected({ reason: "source_invalid", message: "Source Assistant session was not found" }),
                }
              if (!destination?.workspaceID)
                return {
                  type: "error" as const,
                  error: new Rejected({
                    reason: "destination_invalid",
                    message: "Destination Companion session was not found",
                  }),
                }
              if (!source.profileID || !destination.profileID)
                return {
                  type: "error" as const,
                  error: new Rejected({ reason: "profile_missing", message: "Both sessions require trusted profiles" }),
                }

              const sourceProfile = yield* profiles
                .get(Profile.ID.make(source.profileID))
                .pipe(Effect.catchTag("ProfileNotFoundError", () => Effect.succeed(undefined)))
              const destinationProfile = yield* profiles
                .get(Profile.ID.make(destination.profileID))
                .pipe(Effect.catchTag("ProfileNotFoundError", () => Effect.succeed(undefined)))
              // Both Assistant (work) and Companion (continuous) sessions may
              // be grant sources. Assistant→Companion bridges the work scope
              // into the Companion's personal scope (approval-gated by the
              // trust policy); Companion→Companion is a same-scope personal
              // handoff that still requires the user's approval to inject.
              if (sourceProfile?.kind !== "assistant" && sourceProfile?.kind !== "companion")
                return {
                  type: "error" as const,
                  error: new Rejected({
                    reason: "source_not_trusted",
                    message: "Continuity grants require a trusted Assistant or Companion source",
                  }),
                }
              if (destinationProfile?.kind !== "companion")
                return {
                  type: "error" as const,
                  error: new Rejected({
                    reason: "destination_not_companion",
                    message: "Continuity grants require a Companion destination",
                  }),
                }

              const workspace = yield* tx
                .select()
                .from(WorkspaceTable)
                .where(eq(WorkspaceTable.id, destination.workspaceID))
                .get()
              const policy = workspace
                ? WorkspacePolicy.resolve({
                    metadata: {
                      id: workspace.id,
                      type: workspace.type,
                      projectID: workspace.project_id,
                      directory: workspace.directory,
                    },
                    directory: destination.directory,
                  })
                : undefined
              if (policy?.contentScope !== "personal")
                return {
                  type: "error" as const,
                  error: new Rejected({
                    reason: "destination_not_personal",
                    message: "Companion continuity is restricted to a Personal workspace",
                  }),
                }

              // Content-flow: the assistant's work scope may only bridge into
              // the Companion's personal scope through an approved grant. A
              // platform/user "deny" blocks the proposal outright; "ask" is the
              // normal state and resolves when the user approves the grant.
              const sourceWorkspace = source.workspaceID
                ? yield* tx
                    .select()
                    .from(WorkspaceTable)
                    .where(eq(WorkspaceTable.id, source.workspaceID))
                    .get()
                : undefined
              const sourcePolicy = sourceWorkspace
                ? WorkspacePolicy.resolve({
                    metadata: {
                      id: sourceWorkspace.id,
                      type: sourceWorkspace.type,
                      projectID: sourceWorkspace.project_id,
                      directory: sourceWorkspace.directory,
                    },
                    directory: source.directory,
                  })
                : undefined
              const flow = yield* trustPolicy.decide({
                action: "continuity.propose",
                source: sourcePolicy?.contentScope ?? "project",
                destination: "personal",
                actor: source.profileID ?? "continuity",
              })
              if (flow.decision === "deny")
                return {
                  type: "error" as const,
                  error: new Rejected({
                    reason: "workspace_policy",
                    message: "Continuity proposal is not permitted by the content-flow policy",
                  }),
                }

              const row = yield* tx
                .insert(ContinuityGrantTable)
                .values({
                  id: Identifier.ascending("continuityGrant"),
                  source_workspace_id: source.workspaceID ?? null,
                  source_directory: source.directory,
                  source_profile_id: source.profileID,
                  source_session_id: source.id,
                  destination_workspace_id: destination.workspaceID,
                  destination_directory: destination.directory,
                  destination_profile_id: destination.profileID,
                  destination_session_id: destination.id,
                  purpose,
                  summary,
                  relationship_persistence: false,
                  time_expires: input.timeExpires,
                  status: "proposed",
                  time_approved: null,
                  time_revoked: null,
                  time_created: now,
                  time_updated: now,
                })
                .returning()
                .get()
              yield* tx
                .insert(ContinuityGrantAuditTable)
                .values(auditValues(row.id, "proposed", now))
                .run()
              return { type: "row" as const, row }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (result.type === "error") return yield* result.error
      return decode(result.row)
    })

    const listSource = Effect.fn("ContinuityGrant.listSource")(function* (sourceSessionID: SessionSchema.ID) {
      const rows = yield* db
        .select()
        .from(ContinuityGrantTable)
        .where(eq(ContinuityGrantTable.source_session_id, sourceSessionID))
        .orderBy(asc(ContinuityGrantTable.time_created), asc(ContinuityGrantTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    const getSource = Effect.fn("ContinuityGrant.getSource")(function* (input: SourceInput) {
      const row = yield* db
        .select()
        .from(ContinuityGrantTable)
        .where(
          and(eq(ContinuityGrantTable.id, input.id), eq(ContinuityGrantTable.source_session_id, input.sourceSessionID)),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })

    const approve = Effect.fn("ContinuityGrant.approve")(function* (input: SourceInput) {
      const now = Date.now()
      const result: ApproveResult = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select()
                .from(ContinuityGrantTable)
                .where(
                  and(
                    eq(ContinuityGrantTable.id, input.id),
                    eq(ContinuityGrantTable.source_session_id, input.sourceSessionID),
                  ),
                )
                .get()
              if (!current) return { type: "missing" as const }
              if (current.status !== "proposed")
                return {
                  type: "error" as const,
                  error: new InvalidState({
                    id: input.id,
                    status: current.status,
                    message: `Continuity grant cannot be approved from ${current.status}`,
                  }),
                }
              if (current.time_expires <= now)
                return {
                  type: "error" as const,
                  error: new InvalidState({
                    id: input.id,
                    status: current.status,
                    message: "Expired continuity grant cannot be approved",
                  }),
                }
              const row = yield* tx
                .update(ContinuityGrantTable)
                .set({ status: "active", time_approved: now, time_updated: now })
                .where(eq(ContinuityGrantTable.id, current.id))
                .returning()
                .get()
              yield* tx
                .insert(ContinuityGrantAuditTable)
                .values(auditValues(row.id, "approved", now))
                .run()
              return { type: "row" as const, row }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (result.type === "missing") return undefined
      if (result.type === "error") return yield* result.error
      return decode(result.row)
    })

    const auditSource = Effect.fn("ContinuityGrant.auditSource")(function* (input: SourceInput) {
      const owned = yield* db
        .select({ id: ContinuityGrantTable.id })
        .from(ContinuityGrantTable)
        .where(
          and(eq(ContinuityGrantTable.id, input.id), eq(ContinuityGrantTable.source_session_id, input.sourceSessionID)),
        )
        .get()
        .pipe(Effect.orDie)
      if (!owned) return undefined
      const rows = yield* db
        .select()
        .from(ContinuityGrantAuditTable)
        .where(eq(ContinuityGrantAuditTable.grant_id, input.id))
        .orderBy(asc(ContinuityGrantAuditTable.time_created), asc(ContinuityGrantAuditTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decodeAudit)
    })

    const revokeSource = Effect.fn("ContinuityGrant.revokeSource")(function* (input: SourceInput) {
      const now = Date.now()
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select()
                .from(ContinuityGrantTable)
                .where(
                  and(
                    eq(ContinuityGrantTable.id, input.id),
                    eq(ContinuityGrantTable.source_session_id, input.sourceSessionID),
                  ),
                )
                .get()
              if (!current) return undefined
              if (current.status === "revoked") return current
              const row = yield* tx
                .update(ContinuityGrantTable)
                .set({ status: "revoked", time_revoked: now, time_updated: now })
                .where(eq(ContinuityGrantTable.id, current.id))
                .returning()
                .get()
              yield* tx
                .insert(ContinuityGrantAuditTable)
                .values(auditValues(row.id, "revoked", now))
                .run()
              return row
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return result ? decode(result) : undefined
    })

    const takeForPrompt = Effect.fn("ContinuityGrant.takeForPrompt")(function* (input: PromptInput) {
      const now = input.now ?? Date.now()
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const destination = yield* tx
                .select({
                  workspaceID: SessionTable.workspace_id,
                  profileID: SessionTable.profile_id,
                  directory: SessionTable.directory,
                })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.destinationSessionID))
                .get()
              if (
                !destination ||
                destination.workspaceID !== input.destinationWorkspaceID ||
                destination.profileID !== input.destinationProfileID ||
                destination.directory !== input.destinationDirectory
              )
                return []
              const rows = yield* tx
                .select()
                .from(ContinuityGrantTable)
                .where(
                  and(
                    eq(ContinuityGrantTable.destination_session_id, input.destinationSessionID),
                    eq(ContinuityGrantTable.destination_workspace_id, input.destinationWorkspaceID),
                    eq(ContinuityGrantTable.destination_profile_id, input.destinationProfileID),
                    eq(ContinuityGrantTable.destination_directory, input.destinationDirectory),
                    eq(ContinuityGrantTable.status, "active"),
                    gt(ContinuityGrantTable.time_expires, now),
                  ),
                )
                .orderBy(asc(ContinuityGrantTable.time_created), asc(ContinuityGrantTable.id))
                .all()
              if (rows.length > 0) {
                yield* tx
                  .insert(ContinuityGrantAuditTable)
                  .values(rows.map((row) => auditValues(row.id, "injected", now, input.destinationSessionID)))
                  .run()
              }
              return rows.map((row) => ({ purpose: row.purpose, summary: row.summary }))
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    return Service.of({ propose, approve, listSource, getSource, auditSource, revokeSource, takeForPrompt })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Profile.node, TrustPolicy.node],
})

export * as ContinuityGrant from "./index"

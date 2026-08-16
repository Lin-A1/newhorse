import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { MemoryTable, MemoryEntityTable, MemoryHistoryTable } from "@newhorse/core/memory/sql"
import { extractEntities } from "@newhorse/core/memory/entity"
import { MessageTable, SessionTable } from "@newhorse/core/session/sql"
import type {
  MemoryHistoryEvent,
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
import { and, asc, desc, eq, gt, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm"
import fuzzysort from "fuzzysort"
import { Context, Effect, Layer, Ref, Schema } from "effect"

export const Scope = Schema.Literals(["project", "personal", "relationship", "user_global"])
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

export const HistoryEvent = Schema.Literals(["ADD", "UPDATE", "DELETE", "ACCEPT", "REJECT", "PAUSE", "RESUME", "CLEAR"])

// Audit log entry for a single Memory lifecycle transition. History rows have
// no owner columns of their own and survive the physical deletion of the
// memory row, so this is the only way to reconstruct what happened to a record
// after it is gone.
export const HistoryInfo = Schema.Struct({
  id: Schema.String,
  memoryID: Schema.String,
  oldContent: Schema.optional(Schema.String),
  newContent: Schema.optional(Schema.String),
  event: HistoryEvent,
  actorID: Schema.optional(Schema.String),
  createdAt: Schema.Int,
}).annotate({ identifier: "MemoryHistoryInfo" })
export type HistoryInfo = Schema.Schema.Type<typeof HistoryInfo>

/** One workspace's memory bucket in the cross-workspace aggregate view. */
export const AggregateGroup = Schema.Struct({
  workspaceID: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
  scope: Schema.Literals(["workspace", "user_global"]),
  items: Schema.Array(Info),
}).annotate({ identifier: "MemoryAggregateGroup" })
export type AggregateGroup = Schema.Schema.Type<typeof AggregateGroup>

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

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

// ---------------------------------------------------------------------------
// FTS5 (trigram) query building.
//
// Tokenizer choice: trigram (built into FTS5, no extension). unicode61 does
// not segment CJK — a run like "喜欢喝咖啡" becomes one opaque token, so
// Chinese queries fail. trigram indexes every 3-character sequence and serves
// both Latin and CJK. Trade-off: terms shorter than 3 characters cannot be
// matched by trigram at all (dropped here); the LIKE fallback below covers
// those. The matching query uses OR so bm25 does the ranking — memories
// matching more terms rank ahead of memories matching one.
// ---------------------------------------------------------------------------
const MAX_FTS_TERMS = 24

function containsCJK(value: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿]/.test(value)
}

function buildFtsQuery(query: string): string | undefined {
  const terms = new Set<string>()
  for (const rawToken of query.split(/\s+/).filter(Boolean)) {
    // CJK runs are not space-separated: emit overlapping 3..6 char windows so
    // a memory sharing any contiguous substring still matches. ASCII fragments
    // inside a mixed token are kept as ordinary terms.
    for (const chunk of rawToken.split(/([A-Za-z0-9_@#.-]+)/g).filter(Boolean)) {
      if (containsCJK(chunk)) {
        const max = Math.min(6, chunk.length)
        for (let length = 3; length <= max; length++) {
          for (let index = 0; index + length <= chunk.length; index++) {
            terms.add(chunk.slice(index, index + length))
          }
        }
      } else {
        const clean = chunk.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
        if (clean.length >= 3) terms.add(clean)
      }
    }
  }
  if (terms.size === 0) return undefined
  // Most specific (longest) terms first, bounded, so a long recall query does
  // not blow up the OR clause.
  const picked = [...terms]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_FTS_TERMS)
  // Phrase-quote each term to neutralise FTS5 special characters (" : - ( ) * …)
  // and force token identity. `"` inside a phrase is escaped by doubling.
  return picked.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ")
}

const DEFAULT_STATUSES: MemoryStatus[] = ["proposed", "active", "paused"]

// Bounded, host-owned lifecycle maintenance. Expiry/pruning run opportunistically
// from read paths but at most once per interval, and never as a resident daemon.
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000
const MEMORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

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
  readonly search: (input?: {
    query?: string
    kind?: MemoryKind
    status?: MemoryStatus[]
    profileID?: string
    relationshipOnly?: boolean
    limit?: number
    userRuleset?: PermissionV1.Ruleset
  }) => Effect.Effect<ReadonlyArray<Info>>
  readonly maintain: () => Effect.Effect<{ expired: number; pruned: number }>
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
  readonly history: (id: string) => Effect.Effect<ReadonlyArray<HistoryInfo>>
  readonly all: (input?: { profileID?: string }) => Effect.Effect<ReadonlyArray<AggregateGroup>>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Memory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const trustPolicy = yield* TrustPolicy.Service
    const lastMaintain = yield* Ref.make(Date.now())

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

    const maintainInternal = Effect.fn("Memory.maintain")(function* (now: number) {
      // Expire rows whose time_expires has passed: they must no longer surface
      // in any read path, so demote them to deleted (excluded from page/list).
      // The FTS index entry is intentionally left: search filters by status,
      // so a deleted row never surfaces even though it is still indexed.
      const expired = yield* db
        .update(MemoryTable)
        .set({ status: "deleted" as const, time_updated: now })
        .where(and(inArray(MemoryTable.status, ["active", "proposed"]), lt(MemoryTable.time_expires, now)))
        .returning({ id: MemoryTable.id })
        .all()
        .pipe(Effect.orDie)
      // Prune rejected/deleted rows older than the retention window. Deindex
      // FTS and drop entities first (the FTS delete must see the memory rows),
      // then physically remove the rows. History is an audit log and is NOT
      // pruned with its memory row.
      const pruneCondition = and(
        inArray(MemoryTable.status, ["rejected", "deleted"]),
        lt(MemoryTable.time_created, now - MEMORY_RETENTION_MS),
      )
      const pruned = yield* db
        .transaction(
          Effect.fnUntraced(function* (tx) {
            const rows = yield* tx
              .select({ id: MemoryTable.id })
              .from(MemoryTable)
              .where(pruneCondition)
              .all()
            if (rows.length === 0) return []
            const ids = rows.map((row) => row.id)
            yield* ftsDeindex(tx, ids)
            yield* tx.delete(MemoryEntityTable).where(inArray(MemoryEntityTable.memory_id, ids)).run()
            yield* tx.delete(MemoryTable).where(pruneCondition).run()
            return ids
          }),
        )
        .pipe(Effect.orDie)
      return { expired: expired.length, pruned: pruned.length }
    })

    // Throttled opportunistic maintenance from read paths. Never a daemon: it
    // runs at most once per interval per process, piggybacked on a real read.
    const maintainIfDue = Effect.fnUntraced(function* () {
      const now = Date.now()
      if (now - (yield* Ref.get(lastMaintain)) < MAINTENANCE_INTERVAL_MS) return
      yield* Ref.set(lastMaintain, now)
      yield* maintainInternal(now).pipe(Effect.ignore)
    })

    // -----------------------------------------------------------------------
    // FTS5 / entity / history maintenance. The FTS virtual table cannot be
    // declared in the Drizzle schema, so fresh installs (which run schema.up
    // and skip migrations) create it lazily here; existing installs create it
    // in the migration. Entity + history tables exist on both paths.
    // -----------------------------------------------------------------------
    type Exec = Parameters<Parameters<typeof db.transaction>[0]>[0]
    let ftsEnsured = false
    const ensureFts = Effect.fnUntraced(function* () {
      if (ftsEnsured) return
      yield* db.run(sql`
        CREATE VIRTUAL TABLE IF NOT EXISTS \`memory_fts\` USING fts5(content, content='memory', tokenize='trigram')
      `).pipe(Effect.orDie)
      ftsEnsured = true
    })

    // Deindex FTS rows for memory ids. Must run BEFORE the memory rows are
    // deleted or rewritten: external-content FTS reads the content table to
    // update its postings, so the row must still exist at deindex time.
    const ftsDeindex = Effect.fnUntraced(function* (exec: Exec, ids: ReadonlyArray<string>) {
      if (ids.length === 0) return
      yield* exec.run(sql`
        DELETE FROM \`memory_fts\` WHERE rowid IN (
          SELECT \`rowid\` FROM \`memory\` WHERE \`id\` IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        )
      `).pipe(Effect.orDie)
    })

    // Index a memory row into FTS (runs after the memory row exists).
    const ftsIndex = Effect.fnUntraced(function* (exec: Exec, id: string, content: string) {
      yield* exec.run(sql`
        INSERT INTO \`memory_fts\` (rowid, content)
        SELECT \`rowid\`, ${content} FROM \`memory\` WHERE \`id\` = ${id}
      `).pipe(Effect.orDie)
    })

    // Rewrite the entity set for a memory row from its (new) content.
    const replaceEntities = Effect.fnUntraced(function* (exec: Exec, id: string, content: string) {
      yield* exec.delete(MemoryEntityTable).where(eq(MemoryEntityTable.memory_id, id)).run().pipe(Effect.orDie)
      for (const entity of extractEntities(content)) {
        yield* exec
          .insert(MemoryEntityTable)
          .values({
            id: Identifier.ascending("memoryEntity"),
            memory_id: id,
            entity_text: entity.text,
            entity_type: entity.type,
            normalized_text: entity.normalized,
          })
          .run()
          .pipe(Effect.orDie)
      }
    })

    // Append a memory_history audit row. Independent of memory rows: it must
    // survive forget/clear and maintain's 30-day pruning.
    const writeHistory = Effect.fnUntraced(function* (
      exec: Exec,
      event: MemoryHistoryEvent,
      memoryId: string,
      opts: { oldContent?: string | null; newContent?: string | null; actorID?: string | null } = {},
    ) {
      yield* exec
        .insert(MemoryHistoryTable)
        .values({
          id: Identifier.ascending("memoryHistory"),
          memory_id: memoryId,
          old_content: opts.oldContent ?? null,
          new_content: opts.newContent ?? null,
          event,
          actor_id: opts.actorID ?? null,
          created_at: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
    })

    // Entity match counts for a set of candidate memory ids: exact normalized
    // matches plus a small fuzzysort bonus for near-miss entity variants.
    const FUZZY_SCORE_THRESHOLD = -500
    const FUZZY_MATCH_WEIGHT = 0.5
    const entityBoostFor = Effect.fnUntraced(function* (ids: ReadonlyArray<string>, query: string) {
      const hits = new Map<string, number>()
      const entities = extractEntities(query)
      if (entities.length === 0 || ids.length === 0) return hits
      const normals = [...new Set(entities.map((entity) => entity.normalized))]
      const exact = yield* db
        .all<{ memory_id: string; n: number }>(sql`
          SELECT memory_id, count(*) AS n FROM memory_entity
          WHERE memory_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            AND normalized_text IN (${sql.join(normals.map((normalized) => sql`${normalized}`), sql`, `)})
          GROUP BY memory_id
        `)
        .pipe(Effect.orDie)
      for (const row of exact) hits.set(row.memory_id, row.n)
      const stored = yield* db
        .all<{ memory_id: string; normalized_text: string }>(sql`
          SELECT memory_id, normalized_text FROM memory_entity
          WHERE memory_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        `)
        .pipe(Effect.orDie)
      const storedByMemory = new Map<string, string[]>()
      for (const row of stored) {
        const list = storedByMemory.get(row.memory_id) ?? []
        list.push(row.normalized_text)
        storedByMemory.set(row.memory_id, list)
      }
      for (const [memoryId, storedList] of storedByMemory) {
        let fuzzy = 0
        for (const entity of entities) {
          const nearMiss = storedList.some((target) => {
            const result = fuzzysort.single(entity.normalized, target)
            return result !== null && result.score > FUZZY_SCORE_THRESHOLD
          })
          if (nearMiss) fuzzy += 1
        }
        if (fuzzy > 0) hits.set(memoryId, (hits.get(memoryId) ?? 0) + fuzzy * FUZZY_MATCH_WEIGHT)
      }
      return hits
    })

    const maintain: Interface["maintain"] = Effect.fn("Memory.maintain")(function* () {
      return yield* maintainInternal(Date.now())
    })

    const globalFilter = and(
      eq(MemoryTable.scope, "user_global"),
      isNull(MemoryTable.workspace_id),
      isNull(MemoryTable.directory),
    )

    type Owner = { workspaceID?: WorkspaceV2.ID; directory: string; policy: WorkspacePolicy.Info }

    // Relationship rows are written with the owner's workspace_id/directory, so
    // every relationship filter keeps owner isolation — one personal workspace
    // must not see another's relationship memories that happen to share a
    // profile_id (e.g. "companion").
    const ownerIsolation = (owner: Owner) =>
      owner.workspaceID
        ? eq(MemoryTable.workspace_id, owner.workspaceID)
        : and(isNull(MemoryTable.workspace_id), eq(MemoryTable.directory, owner.directory))

    const projectFilter = (owner: Owner) => and(eq(MemoryTable.scope, "project"), ownerIsolation(owner))

    const personalFilter = (owner: Owner) => and(eq(MemoryTable.scope, "personal"), ownerIsolation(owner))

    const relationshipScopeFilter = (owner: Owner) => and(eq(MemoryTable.scope, "relationship"), ownerIsolation(owner))

    // Exclusion helper: non-relationship memories always pass; relationship
    // memories pass only when profileID matches (workspace-isolated).
    const relationshipProfileFilter = (owner: Owner, profileID?: string) =>
      profileID
        ? or(ne(MemoryTable.scope, "relationship"), and(relationshipScopeFilter(owner), eq(MemoryTable.profile_id, profileID)))!
        : ne(MemoryTable.scope, "relationship")

    // Current workspace scope (project or personal per the workspace policy)
    // plus, in a personal context, the workspace's relationship memories so the
    // Memory Center viewer shows Companion memories. Optional user-global.
    const visibleFilter = (owner: Owner, includeGlobal: boolean) => {
      const current =
        owner.policy.contentScope === "personal"
          ? or(personalFilter(owner), relationshipScopeFilter(owner))
          : projectFilter(owner)
      return includeGlobal ? or(current, globalFilter) : current
    }

    const mutationFilter = (scope: MemoryScope, owner: Owner, profileID?: string) => {
      if (scope === "user_global") return globalFilter
      if (scope === "relationship") {
        // Relationship rows are only mutable by the matching profile.
        return profileID
          ? and(relationshipScopeFilter(owner), eq(MemoryTable.profile_id, profileID))
          : eq(MemoryTable.id, "")
      }
      const workspace = scope === "personal" ? personalFilter(owner) : projectFilter(owner)
      // Workspace-scope mutations also reach relationship rows owned by the
      // matching profile (preserves the pre-split behavior where relationship
      // rows lived inside the workspace scope), never relationship rows of a
      // different profile.
      return profileID
        ? or(workspace, and(relationshipScopeFilter(owner), eq(MemoryTable.profile_id, profileID)))!
        : workspace
    }

    // Destination scope for the trust-policy content-flow decision, derived
    // from trusted state only (never accepted from the caller as authority).
    // user_global is explicit; a relationship kind always lands in the
    // relationship scope (existing callers save relationship memories via kind
    // alone, and the scope default in a personal context would otherwise be
    // "personal"); explicit personal/project map directly so the trust policy
    // can reject cross-scope writes instead of silently collapsing them (an
    // explicit project scope in a personal context must be denied, not saved as
    // personal); everything else falls back to the current workspace's content
    // scope.
    const destinationScope = (input: {
      scope: MemoryScope
      kind: MemoryKind
      policy: WorkspacePolicy.Info
    }): TrustPolicy.ContentScope =>
      input.scope === "user_global"
        ? "user_global"
        : input.kind === "relationship"
          ? "relationship"
          : input.scope === "relationship"
            ? "relationship"
            : input.scope === "personal"
              ? "personal"
              : input.scope === "project"
                ? "project"
                : input.policy.contentScope

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
      const destination = destinationScope(input)
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
      const scope = input.scope ?? owner.policy.contentScope
      const effectiveScope = destinationScope({ scope, kind: input.kind, policy: owner.policy })
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
        workspace_id: effectiveScope === "user_global" ? null : (owner.workspaceID ?? null),
        directory: effectiveScope === "user_global" || owner.workspaceID ? null : owner.directory,
        scope: effectiveScope,
        profile_id: effectiveScope === "user_global" ? null : (profileID ?? null),
        kind: input.kind,
        content: input.content.trim(),
        source_session_id: input.sourceSessionID ?? null,
        source_message_id: input.sourceMessageID ?? null,
        provenance: input.provenance,
        confidence: input.confidence ?? null,
        sensitivity: "normal" as const,
        // No-approval: auto-extracted / tool-saved memories take effect
        // immediately. The `proposed` status is retained in the enum for
        // historical rows only; decide() remains as a legacy-compat no-op
        // for those rows.
        status: "active" as const,
        time_created: now,
        time_updated: now,
        time_expires: input.expiresAt ?? null,
      }
      yield* ensureFts()
      const saved = yield* db
        .transaction(
          Effect.fnUntraced(function* (tx) {
            const inserted = yield* tx.insert(MemoryTable).values(row).returning().get()
            yield* ftsIndex(tx, row.id, row.content)
            yield* replaceEntities(tx, row.id, row.content)
            yield* writeHistory(tx, "ADD", row.id, { newContent: row.content, actorID: profileID })
            return inserted
          }),
        )
        .pipe(Effect.orDie)
      return decode(saved!)
    })

    const filters = Effect.fn("Memory.filters")(function* (input?: QueryInput) {
      const owner = yield* context
      const conditions = [
        visibleFilter(owner, input?.includeGlobal ?? true),
        inArray(MemoryTable.status, input?.status ?? DEFAULT_STATUSES),
      ]
      // The Memory Center (page/list/count) is the user's own memory hub: in a
      // personal context it shows that profile's relationship (Companion)
      // memories — but only to a TRUSTED profile. Relationship rows are
      // sensitive; without a trusted profile (session-less request, a
      // client-declared profileID is never authority) they are excluded, exactly
      // like `retrieve`/`export` do. Project contexts always exclude them.
      if (owner.policy.contentScope !== "personal" || !input?.profileID) {
        conditions.push(ne(MemoryTable.scope, "relationship"))
      } else {
        conditions.push(relationshipProfileFilter(owner, input.profileID))
      }
      if (input?.profileID) {
        conditions.push(or(eq(MemoryTable.scope, "user_global"), eq(MemoryTable.profile_id, input.profileID))!)
      }
      if (input?.cursor) conditions.push(lt(MemoryTable.id, input.cursor))
      return and(...conditions)
    })

    const page: Interface["page"] = Effect.fn("Memory.page")(function* (input) {
      yield* maintainIfDue()
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
      yield* maintainIfDue()
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(yield* filters(input))
        .orderBy(desc(MemoryTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    // Cross-workspace aggregate for the Memory Center "all workspaces" view.
    // Read-only: never mutates, and the caller's trusted profileID (from the
    // workspace route — never a client-declared value) gates relationship rows
    // so no other profile's relationship memory leaks. Project/personal rows
    // are the local user's own memories across their own workspaces. Rows
    // without a workspace_id (directory-scoped legacy rows) bucket under the
    // directory; user_global rows get their own bucket.
    const all: Interface["all"] = Effect.fn("Memory.all")(function* (input) {
      yield* maintainIfDue()
      const conditions = [
        inArray(MemoryTable.status, DEFAULT_STATUSES),
        or(
          ne(MemoryTable.scope, "relationship"),
          and(eq(MemoryTable.scope, "relationship"), eq(MemoryTable.profile_id, input?.profileID ?? "")),
        )!,
      ]
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(and(...conditions))
        .orderBy(desc(MemoryTable.id))
        .all()
        .pipe(Effect.orDie)
      type Bucket = { scope: "workspace" | "user_global"; workspaceID?: string; directory?: string; items: Info[] }
      const buckets = new Map<string, Bucket>()
      for (const row of rows) {
        const decoded = decode(row)
        if (row.scope === "user_global") {
          const key = "global"
          const bucket = buckets.get(key)
          if (bucket) bucket.items.push(decoded)
          else buckets.set(key, { scope: "user_global", items: [decoded] })
          continue
        }
        const key = row.workspace_id ?? `dir:${row.directory ?? ""}`
        const bucket = buckets.get(key)
        if (bucket) bucket.items.push(decoded)
        else
          buckets.set(key, {
            scope: "workspace",
            ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
            ...(row.directory ? { directory: row.directory } : {}),
            items: [decoded],
          })
      }
      return Array.from(buckets.values())
    })

    const count: Interface["count"] = Effect.fn("Memory.count")(function* (input) {
      yield* maintainIfDue()
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
      yield* maintainIfDue()
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
        conditions.push(eq(MemoryTable.scope, "relationship"), eq(MemoryTable.profile_id, input.profileID!))
      } else {
        conditions.push(relationshipProfileFilter(owner, input?.profileID))
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

    const search: Interface["search"] = Effect.fn("Memory.search")(function* (input) {
      const owner = yield* context
      yield* maintainIfDue()
      const query = input?.query?.trim()
      if (!query) return []
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
        inArray(MemoryTable.status, input?.status ?? ["active"]),
        or(isNull(MemoryTable.time_expires), gt(MemoryTable.time_expires, Date.now())),
      ]
      if (input?.kind) conditions.push(eq(MemoryTable.kind, input.kind))
      if (input?.relationshipOnly) {
        conditions.push(eq(MemoryTable.scope, "relationship"), eq(MemoryTable.profile_id, input.profileID!))
      } else {
        conditions.push(relationshipProfileFilter(owner, input?.profileID))
        if (input?.profileID) {
          conditions.push(or(eq(MemoryTable.scope, "user_global"), eq(MemoryTable.profile_id, input.profileID))!)
        }
      }
      const limit = Math.min(Math.max(input?.limit ?? 10, 1), 50)

      // Primary path: FTS5 trigram MATCH + bm25 ranking. The visibility /
      // kind / profile / status filters still come from the memory table:
      // FTS rowids are correlated to memory.rowid, then mapped to memory ids
      // for the visibility query.
      yield* ensureFts()
      const ftsQuery = buildFtsQuery(query)
      if (ftsQuery) {
        const ftsRows = yield* db
          .all<{ rowid: number; rank: number }>(sql`
            SELECT memory_fts.rowid AS rowid, bm25(memory_fts) AS rank
            FROM memory_fts
            WHERE memory_fts MATCH ${ftsQuery}
            ORDER BY bm25(memory_fts)
            LIMIT 200
          `)
          .pipe(Effect.catchCause(() => Effect.succeed([])))
        if (ftsRows.length > 0) {
          const idRows = yield* db
            .all<{ id: string; rowid: number }>(sql`
              SELECT id, rowid FROM memory
              WHERE rowid IN (${sql.join(ftsRows.map((row) => sql`${row.rowid}`), sql`, `)})
            `)
            .pipe(Effect.orDie)
          const idByRowid = new Map(idRows.map((row) => [row.rowid, row.id]))
          const ids = ftsRows
            .map((row) => idByRowid.get(row.rowid))
            .filter((id): id is string => !!id)
          if (ids.length > 0) {
            const rows = yield* db
              .select()
              .from(MemoryTable)
              .where(and(...conditions, inArray(MemoryTable.id, ids)))
              .all()
              .pipe(Effect.orDie)
            if (rows.length > 0) {
              const rankByRowid = new Map(ftsRows.map((row) => [row.rowid, row.rank]))
              const rowidById = new Map(idRows.map((row) => [row.id, row.rowid]))
              const entityHits = yield* entityBoostFor(ids, query)
              const ranked = rows
                .map((row) => ({
                  row,
                  rank: rankByRowid.get(rowidById.get(row.id) ?? 0) ?? 0,
                  hits: entityHits.get(row.id) ?? 0,
                }))
                .sort((a, b) => a.rank - b.rank || b.hits - a.hits || b.row.time_updated - a.row.time_updated)
                .slice(0, limit)
                .map((entry) => decode(entry.row))
              return ranked
            }
          }
        }
      }

      // Fallback: LIKE-based substring search. Kept for queries FTS cannot
      // serve (terms shorter than 3 characters — e.g. 2-character CJK words —
      // which the trigram tokenizer drops) and when the MATCH finds nothing.
      // Tokenize the query: match any keyword (OR) instead of requiring the
      // whole query to be a substring — "weekend hiking plan" should surface a
      // memory about "hiking" even without the full phrase.
      const terms = query.split(/\s+/).filter(Boolean)
      if (terms.length === 1) {
        conditions.push(like(MemoryTable.content, `%${escapeLike(query)}%`))
      } else {
        conditions.push(or(...terms.map((term) => like(MemoryTable.content, `%${escapeLike(term)}%`))))
      }
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(and(...conditions))
        // Multi-signal ranking (mem0-inspired): memories matching more query
        // terms rank first, then match position, then recency. A memory about
        // "hiking" beats one about "weekend" for the query "weekend hiking".
        .orderBy(
          desc(
            sql`(${sql.join(
              terms.map((term) =>
                sql`(case when ${MemoryTable.content} like ${`%${escapeLike(term)}%`} then 1 else 0 end)`,
              ),
              sql` + `,
            )})`,
          ),
          sql`instr(${MemoryTable.content}, ${query})`,
          desc(MemoryTable.time_updated),
        )
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    const update: Interface["update"] = Effect.fn("Memory.update")(function* (input) {
      const owner = yield* context
      const scope = input.scope ?? owner.policy.contentScope
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
      // A memory converted to (or kept as) relationship kind must live in the
      // relationship scope; the trust-policy destination then reflects where
      // the data actually lands.
      yield* validate({
        scope: kind === "relationship" ? "relationship" : scope,
        kind,
        content,
        profileID: current.profile_id ?? undefined,
        policy: owner.policy,
        sensitivity: current.sensitivity,
        userRuleset: input.userRuleset,
      })
      yield* ensureFts()
      const row = yield* db
        .transaction(
          Effect.fnUntraced(function* (tx) {
            // Deindex the OLD content first (external-content FTS reads the
            // memory row to update postings), then apply the update and index
            // the new content.
            yield* ftsDeindex(tx, [input.id])
            const updated = yield* tx
              .update(MemoryTable)
              .set({
                kind,
                content: content.trim(),
                ...(input.expiresAt !== undefined ? { time_expires: input.expiresAt } : {}),
                ...(kind === "relationship" ? { scope: "relationship" as const } : {}),
                time_updated: Date.now(),
              })
              .where(and(eq(MemoryTable.id, input.id), mutationFilter(scope, owner, input.profileID)))
              .returning()
              .get()
            if (!updated) return undefined
            yield* ftsIndex(tx, updated.id, updated.content)
            yield* replaceEntities(tx, updated.id, updated.content)
            yield* writeHistory(tx, "UPDATE", updated.id, {
              oldContent: current.content,
              newContent: updated.content,
              actorID: input.profileID,
            })
            return updated
          }),
        )
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })

    const decide: Interface["decide"] = Effect.fn("Memory.decide")(function* (input) {
      const owner = yield* context
      const scope = input.scope ?? owner.policy.contentScope
      const row = yield* db
        .transaction(
          Effect.fnUntraced(function* (tx) {
            const updated = yield* tx
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
            if (updated) {
              yield* writeHistory(tx, input.decision === "accept" ? "ACCEPT" : "REJECT", updated.id, {
                actorID: input.profileID,
              })
            }
            return updated
          }),
        )
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })

    const pause: Interface["pause"] = Effect.fn("Memory.pause")(function* (input) {
      const owner = yield* context
      const scope = input.scope ?? owner.policy.contentScope
      const row = yield* db
        .transaction(
          Effect.fnUntraced(function* (tx) {
            const updated = yield* tx
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
            if (updated) {
              yield* writeHistory(tx, input.paused ? "PAUSE" : "RESUME", updated.id, { actorID: input.profileID })
            }
            return updated
          }),
        )
        .pipe(Effect.orDie)
      return row ? decode(row) : undefined
    })

    const forget: Interface["forget"] = Effect.fn("Memory.forget")(function* (id, scope, profileID) {
      const owner = yield* context
      const effectiveScope = scope ?? owner.policy.contentScope
      yield* ensureFts()
      const row = yield* db
        .transaction(
          Effect.fnUntraced(function* (tx) {
            const target = yield* tx
              .select({ id: MemoryTable.id, content: MemoryTable.content })
              .from(MemoryTable)
              .where(and(eq(MemoryTable.id, id), mutationFilter(effectiveScope, owner, profileID)))
              .get()
            if (!target) return undefined
            // Deindex FTS and drop entities before the row disappears.
            yield* ftsDeindex(tx, [id])
            yield* tx.delete(MemoryEntityTable).where(eq(MemoryEntityTable.memory_id, id)).run()
            yield* tx
              .delete(MemoryTable)
              .where(and(eq(MemoryTable.id, id), mutationFilter(effectiveScope, owner, profileID)))
              .run()
            yield* writeHistory(tx, "DELETE", id, { oldContent: target.content, actorID: profileID })
            return { id }
          }),
        )
        .pipe(Effect.orDie)
      return !!row
    })

    const clear: Interface["clear"] = Effect.fn("Memory.clear")(function* (input) {
      const owner = yield* context
      const target = input?.target ?? "workspace"
      // Legacy "workspace" target = everything non-global in this workspace:
      // the current workspace scope (project or personal) plus its relationship
      // rows, mirroring the pre-split workspace semantics.
      let condition =
        owner.policy.contentScope === "personal"
          ? or(personalFilter(owner), relationshipScopeFilter(owner))
          : projectFilter(owner)
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
        condition = and(relationshipScopeFilter(owner), eq(MemoryTable.profile_id, input.profileID))!
      }
      yield* ensureFts()
      return yield* db
        .transaction(
          Effect.fnUntraced(function* (tx) {
            const rows = yield* tx
              .select({ id: MemoryTable.id, content: MemoryTable.content })
              .from(MemoryTable)
              .where(condition)
              .all()
            if (rows.length > 0) {
              const ids = rows.map((row) => row.id)
              yield* ftsDeindex(tx, ids)
              yield* tx.delete(MemoryEntityTable).where(inArray(MemoryEntityTable.memory_id, ids)).run()
              yield* tx.delete(MemoryTable).where(condition).run()
              for (const row of rows) {
                yield* writeHistory(tx, "CLEAR", row.id, { oldContent: row.content, actorID: input?.profileID })
              }
            }
            return rows.length
          }),
        )
        .pipe(Effect.orDie)
    })

    const exportRecords: Interface["export"] = Effect.fn("Memory.export")(function* (input) {
      const owner = yield* context
      const conditions = [visibleFilter(owner, input?.includeGlobal ?? true), ne(MemoryTable.status, "deleted")]
      if (owner.policy.contentScope !== "personal") conditions.push(ne(MemoryTable.scope, "relationship"))
      else conditions.push(relationshipProfileFilter(owner, input?.profileID))
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

    const history: Interface["history"] = Effect.fn("Memory.history")(function* (id) {
      // Audit log is keyed by memory_id and intentionally has no owner scope:
      // it must survive forget/clear/prune, so the owning memory row cannot be
      // used to scope it. Oldest first so a UI can replay the record's timeline.
      const rows = yield* db
        .select()
        .from(MemoryHistoryTable)
        .where(eq(MemoryHistoryTable.memory_id, id))
        .orderBy(asc(MemoryHistoryTable.created_at), asc(MemoryHistoryTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        memoryID: row.memory_id!,
        oldContent: row.old_content ?? undefined,
        newContent: row.new_content ?? undefined,
        event: row.event,
        actorID: row.actor_id ?? undefined,
        createdAt: row.created_at,
      }))
    })

    return Service.of({
      save,
      page,
      list,
      count,
      retrieve,
      search,
      maintain,
      update,
      decide,
      pause,
      forget,
      clear,
      export: exportRecords,
      history,
      all,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, TrustPolicy.node],
})

export * as Memory from "./index"

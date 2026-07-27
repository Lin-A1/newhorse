import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Database } from "@newhorse/core/database/database"
import { MemoryTable } from "@newhorse/core/memory/sql"
import { SessionTable } from "@newhorse/core/session/sql"
import type {
  MemoryKind,
  MemoryProvenance,
  MemoryScope,
  MemorySensitivity,
  MemoryStatus,
} from "@newhorse/core/memory/sql"
import type { WorkspaceV2 } from "@newhorse/core/workspace"
import type { SessionSchema } from "@newhorse/core/session/schema"
import { Identifier } from "@newhorse/core/id/id"
import { InstanceState } from "@/effect/instance-state"
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"

export interface Info {
  id: string
  workspaceID?: WorkspaceV2.ID
  profileID?: string
  scope: MemoryScope
  kind: MemoryKind
  content: string
  provenance: MemoryProvenance
  sensitivity: MemorySensitivity
  status: MemoryStatus
  confidence?: number
  timeCreated: number
  timeExpires?: number
}

export interface SaveInput {
  scope?: MemoryScope
  kind: MemoryKind
  content: string
  provenance: MemoryProvenance
  sensitivity?: MemorySensitivity
  confidence?: number
  sourceSessionID?: SessionSchema.ID
  profileID?: string
  expiresAt?: number
}

// Until field-level encryption and a key-rotation story exist, sensitive
// content is refused outright rather than written to a plaintext database.
export class SensitiveMemoryRejected extends Error {
  readonly _tag = "SensitiveMemoryRejected"
  constructor() {
    super("Sensitive memory cannot be stored until encryption at rest is available")
  }
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b(?:password|passwd|secret|api[_-]?key|token|credential)\b\s*[:=]/i,
]

export function detectSensitive(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))
}

export interface Interface {
  readonly save: (input: SaveInput) => Effect.Effect<Info, SensitiveMemoryRejected>
  readonly list: (input?: { status?: MemoryStatus[]; includeGlobal?: boolean }) => Effect.Effect<Info[]>
  readonly retrieve: (input?: {
    limit?: number
    profileID?: string
    relationshipOnly?: boolean
  }) => Effect.Effect<Info[]>
  readonly setStatus: (input: { id: string; status: MemoryStatus }) => Effect.Effect<void>
  readonly forget: (id: string) => Effect.Effect<void>
  readonly clear: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Memory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const decode = (row: typeof MemoryTable.$inferSelect): Info => ({
      id: row.id,
      workspaceID: row.workspace_id ?? undefined,
      profileID: row.profile_id ?? undefined,
      scope: row.scope,
      kind: row.kind,
      content: row.content,
      provenance: row.provenance,
      sensitivity: row.sensitivity,
      status: row.status,
      confidence: row.confidence ?? undefined,
      timeCreated: row.time_created,
      timeExpires: row.time_expires ?? undefined,
    })

    const save = Effect.fn("Memory.save")(function* (input: SaveInput) {
      const sensitivity: MemorySensitivity =
        input.sensitivity ?? (detectSensitive(input.content) ? "sensitive" : "normal")
      if (sensitivity === "sensitive") return yield* Effect.fail(new SensitiveMemoryRejected())

      const workspaceID = yield* InstanceState.workspaceID
      const scope = input.scope ?? "workspace"
      // Model inference is a proposal, never a fact the assistant may rely on.
      const status: MemoryStatus = input.provenance === "model_inferred" ? "proposed" : "active"
      const profileID = input.profileID
        ? input.profileID
        : input.sourceSessionID
          ? yield* db
              .select({ profileID: SessionTable.profile_id })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sourceSessionID))
              .get()
              .pipe(
                Effect.orDie,
                Effect.map((row) => row?.profileID ?? undefined),
              )
          : undefined
      const row = {
        id: Identifier.ascending("memory"),
        workspace_id: scope === "user_global" ? null : (workspaceID ?? null),
        scope,
        profile_id: scope === "user_global" ? null : (profileID ?? null),
        kind: input.kind,
        content: input.content,
        source_session_id: input.sourceSessionID ?? null,
        provenance: input.provenance,
        confidence: input.confidence ?? null,
        sensitivity,
        status,
        time_created: Date.now(),
        time_updated: Date.now(),
        time_expires: input.expiresAt ?? null,
      }
      yield* db.insert(MemoryTable).values([row]).run().pipe(Effect.orDie)
      const saved = yield* db.select().from(MemoryTable).where(eq(MemoryTable.id, row.id)).get().pipe(Effect.orDie)
      return decode(saved!)
    })

    // Workspace memory never leaks across workspaces; user_global preferences
    // flow in one direction only, into the current workspace.
    const scopeFilter = (workspaceID: WorkspaceV2.ID | undefined, includeGlobal: boolean) => {
      const workspace = workspaceID ? eq(MemoryTable.workspace_id, workspaceID) : isNull(MemoryTable.workspace_id)
      const own = and(eq(MemoryTable.scope, "workspace"), workspace)
      if (!includeGlobal) return own
      return or(own, and(eq(MemoryTable.scope, "user_global"), isNull(MemoryTable.workspace_id)))
    }

    const list = Effect.fn("Memory.list")(function* (input?: { status?: MemoryStatus[]; includeGlobal?: boolean }) {
      const workspaceID = yield* InstanceState.workspaceID
      const status = input?.status ?? ["proposed", "active"]
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(and(scopeFilter(workspaceID, input?.includeGlobal ?? true), inArray(MemoryTable.status, status)))
        .orderBy(desc(MemoryTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    const retrieve = Effect.fn("Memory.retrieve")(function* (input?: {
      limit?: number
      profileID?: string
      relationshipOnly?: boolean
    }) {
      const workspaceID = yield* InstanceState.workspaceID
      const now = Date.now()
      const conditions = [
        scopeFilter(workspaceID, !input?.relationshipOnly),
        eq(MemoryTable.status, "active"),
        or(isNull(MemoryTable.time_expires), gt(MemoryTable.time_expires, now)),
      ]
      if (input?.relationshipOnly) conditions.push(eq(MemoryTable.kind, "relationship"))
      if (input?.profileID) {
        conditions.push(
          or(eq(MemoryTable.scope, "user_global"), eq(MemoryTable.profile_id, input.profileID)),
        )
      }
      const rows = yield* db
        .select()
        .from(MemoryTable)
        .where(and(...conditions))
        .orderBy(desc(MemoryTable.time_created))
        .limit(input?.limit ?? 20)
        .all()
        .pipe(Effect.orDie)
      return rows.map(decode)
    })

    const setStatus = Effect.fn("Memory.setStatus")(function* (input: { id: string; status: MemoryStatus }) {
      const workspaceID = yield* InstanceState.workspaceID
      yield* db
        .update(MemoryTable)
        .set({ status: input.status, time_updated: Date.now() })
        .where(and(eq(MemoryTable.id, input.id), scopeFilter(workspaceID, true)))
        .run()
        .pipe(Effect.orDie)
    })

    const forget = Effect.fn("Memory.forget")(function* (id: string) {
      const workspaceID = yield* InstanceState.workspaceID
      yield* db
        .delete(MemoryTable)
        .where(and(eq(MemoryTable.id, id), scopeFilter(workspaceID, true)))
        .run()
        .pipe(Effect.orDie)
    })

    // Scope is matched explicitly: an unbound workspace also has a null
    // workspace_id, so filtering on the column alone would delete the user's
    // global preferences along with it.
    const clear = Effect.fn("Memory.clear")(function* () {
      const workspaceID = yield* InstanceState.workspaceID
      yield* db
        .delete(MemoryTable)
        .where(and(eq(MemoryTable.scope, "workspace"), scopeFilter(workspaceID, false)))
        .run()
        .pipe(Effect.orDie)
    })

    return Service.of({ save, list, retrieve, setStatus, forget, clear })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as Memory from "./index"

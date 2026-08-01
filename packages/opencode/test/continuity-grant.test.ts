import { afterEach, describe, expect } from "bun:test"
import { ContinuityGrantAuditTable } from "@newhorse/core/continuity-grant/sql"
import { WorkspaceTable } from "@newhorse/core/control-plane/workspace.sql"
import { Database } from "@newhorse/core/database/database"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { ProjectV2 } from "@newhorse/core/project"
import { ProjectTable } from "@newhorse/core/project/sql"
import { AbsolutePath } from "@newhorse/core/schema"
import { SessionSchema } from "@newhorse/core/session/schema"
import { SessionTable } from "@newhorse/core/session/sql"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { ContinuityGrant } from "@/continuity-grant"
import { Profile } from "@/profile"
import { resetDatabase } from "./fixture/db"
import { testEffect } from "./lib/effect"

const assistantID = Profile.ID.make("assistant")
const companionID = Profile.ID.make("companion")
const profiles = [
  { id: assistantID, kind: "assistant" as const, name: "Assistant", memory: "ask" as const, proactive: false },
  { id: companionID, kind: "companion" as const, name: "Companion", memory: "ask" as const, proactive: false },
]

const profileLayer = Layer.mock(Profile.Service)({
  get: (id) => {
    const result = profiles.find((item) => item.id === id)
    return result
      ? Effect.succeed(result)
      : Effect.fail(new Profile.NotFoundError({ profileID: id ?? assistantID, message: "not found" }))
  },
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([ContinuityGrant.node, Database.node]), [[Profile.node, profileLayer]]),
)

afterEach(async () => {
  await resetDatabase()
})

const seed = Effect.gen(function* () {
  const suffix = crypto.randomUUID()
  const sourceSessionID = SessionSchema.ID.make(`ses_source_${suffix}`)
  const otherSourceSessionID = SessionSchema.ID.make(`ses_other_${suffix}`)
  const destinationSessionID = SessionSchema.ID.make(`ses_destination_${suffix}`)
  const sourceWorkspaceID = WorkspaceV2.ID.make(`wrk_source_${suffix}`)
  const destinationWorkspaceID = WorkspaceV2.ID.make(`wrk_destination_${suffix}`)
  const sourceDirectory = AbsolutePath.make(`/project/${suffix}`)
  const destinationDirectory = AbsolutePath.make(`/personal/${suffix}`)
  const now = Date.now()
  const { db } = yield* Database.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values([
      {
        id: sourceWorkspaceID,
        type: "local",
        name: "source",
        directory: sourceDirectory,
        project_id: ProjectV2.ID.global,
      },
      {
        id: destinationWorkspaceID,
        type: "personal",
        name: "destination",
        directory: destinationDirectory,
        project_id: ProjectV2.ID.global,
      },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sourceSessionID,
        project_id: ProjectV2.ID.global,
        workspace_id: sourceWorkspaceID,
        profile_id: assistantID,
        slug: sourceSessionID,
        directory: sourceDirectory,
        title: "source",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      },
      {
        id: otherSourceSessionID,
        project_id: ProjectV2.ID.global,
        workspace_id: sourceWorkspaceID,
        profile_id: assistantID,
        slug: otherSourceSessionID,
        directory: sourceDirectory,
        title: "other source",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      },
      {
        id: destinationSessionID,
        project_id: ProjectV2.ID.global,
        workspace_id: destinationWorkspaceID,
        profile_id: companionID,
        slug: destinationSessionID,
        directory: destinationDirectory,
        title: "destination",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      },
    ])
    .run()
    .pipe(Effect.orDie)

  return {
    db,
    sourceSessionID,
    otherSourceSessionID,
    destinationSessionID,
    sourceWorkspaceID,
    destinationWorkspaceID,
    sourceDirectory,
    destinationDirectory,
  }
})

type Seeded = {
  db: Database.Interface["db"]
  sourceSessionID: SessionSchema.ID
  otherSourceSessionID: SessionSchema.ID
  destinationSessionID: SessionSchema.ID
  sourceWorkspaceID: WorkspaceV2.ID
  destinationWorkspaceID: WorkspaceV2.ID
  sourceDirectory: AbsolutePath
  destinationDirectory: AbsolutePath
}

const propose = (
  service: ContinuityGrant.Interface,
  seeded: Seeded,
  input: Partial<ContinuityGrant.ProposeInput> = {},
) =>
  service.propose({
    sourceSessionID: seeded.sourceSessionID,
    destinationSessionID: seeded.destinationSessionID,
    purpose: "Preserve the user's approved planning context",
    summary: "The user prefers a concise weekly plan.",
    timeExpires: Date.now() + 60_000,
    ...input,
  })

describe("ContinuityGrant domain", () => {
  it.live("rejects invalid text and expiry before persistence", () =>
    Effect.gen(function* () {
      const seeded = yield* seed
      const service = yield* ContinuityGrant.Service
      const cases: Array<[Partial<ContinuityGrant.ProposeInput>, string]> = [
        [{ purpose: "   " }, "purpose_required"],
        [{ summary: `valid${String.fromCharCode(0)}invalid` }, "summary_control_character"],
        [{ purpose: "x".repeat(501) }, "purpose_too_long"],
        [{ summary: "x".repeat(4_001) }, "summary_too_long"],
        [{ timeExpires: Date.now() - 1 }, "expiry_not_future"],
        [{ timeExpires: Date.now() + 31 * 24 * 60 * 60 * 1_000 }, "expiry_too_far"],
      ]

      for (const [input, reason] of cases) {
        const error = yield* Effect.flip(propose(service, seeded, input))
        expect(error.reason).toBe(reason)
      }
      expect(yield* service.listSource(seeded.sourceSessionID)).toEqual([])
    }),
  )

  it.live("rejects missing and invalid persisted authority", () =>
    Effect.gen(function* () {
      const seeded = yield* seed
      const service = yield* ContinuityGrant.Service

      expect(
        (yield* Effect.flip(
          propose(service, seeded, { sourceSessionID: SessionSchema.ID.make(`ses_missing_${crypto.randomUUID()}`) }),
        )).reason,
      ).toBe("source_invalid")
      expect(
        (yield* Effect.flip(
          propose(service, seeded, {
            destinationSessionID: SessionSchema.ID.make(`ses_missing_${crypto.randomUUID()}`),
          }),
        )).reason,
      ).toBe("destination_invalid")

      yield* seeded.db
        .update(SessionTable)
        .set({ profile_id: null })
        .where(eq(SessionTable.id, seeded.destinationSessionID))
        .run()
        .pipe(Effect.orDie)
      expect((yield* Effect.flip(propose(service, seeded))).reason).toBe("profile_missing")

      yield* seeded.db
        .update(SessionTable)
        .set({ profile_id: assistantID })
        .where(eq(SessionTable.id, seeded.destinationSessionID))
        .run()
        .pipe(Effect.orDie)
      expect((yield* Effect.flip(propose(service, seeded))).reason).toBe("destination_not_companion")
      expect(yield* service.listSource(seeded.sourceSessionID)).toEqual([])
    }),
  )

  it.live("uses persisted profile and workspace metadata as authority", () =>
    Effect.gen(function* () {
      const seeded = yield* seed
      const service = yield* ContinuityGrant.Service

      yield* seeded.db
        .update(SessionTable)
        .set({ profile_id: companionID })
        .where(eq(SessionTable.id, seeded.sourceSessionID))
        .run()
        .pipe(Effect.orDie)
      expect((yield* Effect.flip(propose(service, seeded))).reason).toBe("source_not_assistant")

      yield* seeded.db
        .update(SessionTable)
        .set({ profile_id: assistantID })
        .where(eq(SessionTable.id, seeded.sourceSessionID))
        .run()
        .pipe(Effect.orDie)
      yield* seeded.db
        .update(WorkspaceTable)
        .set({ type: "local", directory: seeded.destinationDirectory })
        .where(eq(WorkspaceTable.id, seeded.destinationWorkspaceID))
        .run()
        .pipe(Effect.orDie)
      expect((yield* Effect.flip(propose(service, seeded))).reason).toBe("destination_not_personal")
    }),
  )

  it.live("hides grants from other source sessions", () =>
    Effect.gen(function* () {
      const seeded = yield* seed
      const service = yield* ContinuityGrant.Service
      const grant = yield* propose(service, seeded)
      const foreign = { sourceSessionID: seeded.otherSourceSessionID, id: grant.id }

      expect(yield* service.listSource(seeded.otherSourceSessionID)).toEqual([])
      expect(yield* service.getSource(foreign)).toBeUndefined()
      expect(yield* service.auditSource(foreign)).toBeUndefined()
      expect(yield* service.approve(foreign)).toBeUndefined()
      expect(yield* service.revokeSource(foreign)).toBeUndefined()
      expect((yield* service.getSource({ sourceSessionID: seeded.sourceSessionID, id: grant.id }))?.status).toBe(
        "proposed",
      )
    }),
  )

  it.live("rolls back approval when its audit cannot be persisted", () =>
    Effect.gen(function* () {
      const seeded = yield* seed
      const service = yield* ContinuityGrant.Service
      const grant = yield* propose(service, seeded)
      const source = { sourceSessionID: seeded.sourceSessionID, id: grant.id }

      yield* seeded.db
        .run(
          `
          CREATE TRIGGER continuity_grant_audit_reject_approval
          BEFORE INSERT ON continuity_grant_audit
          WHEN NEW.action = 'approved'
          BEGIN
            SELECT RAISE(ABORT, 'approval audit rejected');
          END;
        `,
        )
        .pipe(Effect.orDie)
      const exit = yield* Effect.exit(service.approve(source))
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* service.getSource(source))?.status).toBe("proposed")
      expect((yield* service.auditSource(source))?.map((item) => item.action)).toEqual(["proposed"])
    }),
  )

  it.live("approves, repeatedly injects, audits, and immediately revokes a minimized grant", () =>
    Effect.gen(function* () {
      const seeded = yield* seed
      const service = yield* ContinuityGrant.Service
      const grant = yield* propose(service, seeded, {
        purpose: "  approved purpose  ",
        summary: "  approved summary  ",
      })
      const source = { sourceSessionID: seeded.sourceSessionID, id: grant.id }

      expect(grant).toMatchObject({
        purpose: "approved purpose",
        summary: "approved summary",
        relationshipPersistence: false,
        status: "proposed",
      })
      expect((yield* service.approve(source))?.status).toBe("active")
      expect((yield* Effect.flip(service.approve(source)))._tag).toBe("ContinuityGrant.InvalidState")

      const promptInput = {
        destinationSessionID: seeded.destinationSessionID,
        destinationWorkspaceID: seeded.destinationWorkspaceID,
        destinationProfileID: companionID,
        destinationDirectory: seeded.destinationDirectory,
      }
      expect(yield* service.takeForPrompt(promptInput)).toEqual([
        { purpose: "approved purpose", summary: "approved summary" },
      ])
      expect(yield* service.takeForPrompt(promptInput)).toEqual([
        { purpose: "approved purpose", summary: "approved summary" },
      ])
      expect(yield* service.takeForPrompt({ ...promptInput, destinationProfileID: assistantID })).toEqual([])
      expect(
        yield* service.takeForPrompt({
          ...promptInput,
          destinationWorkspaceID: WorkspaceV2.ID.make(`wrk_other_${crypto.randomUUID()}`),
        }),
      ).toEqual([])
      expect(yield* service.takeForPrompt({ ...promptInput, destinationDirectory: "/personal/other" })).toEqual([])
      expect(yield* service.takeForPrompt({ ...promptInput, now: grant.timeExpires })).toEqual([])

      const audit = yield* service.auditSource(source)
      expect(audit?.map((item) => item.action)).toEqual(["proposed", "approved", "injected", "injected"])
      expect(JSON.stringify(audit)).not.toContain("approved purpose")
      expect(JSON.stringify(audit)).not.toContain("approved summary")
      expect(
        yield* seeded.db
          .select()
          .from(ContinuityGrantAuditTable)
          .where(eq(ContinuityGrantAuditTable.grant_id, grant.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(4)

      expect((yield* service.revokeSource(source))?.status).toBe("revoked")
      expect((yield* service.revokeSource(source))?.status).toBe("revoked")
      expect(yield* service.takeForPrompt(promptInput)).toEqual([])
      expect((yield* service.auditSource(source))?.map((item) => item.action)).toEqual([
        "proposed",
        "approved",
        "injected",
        "injected",
        "revoked",
      ])
    }),
  )
})

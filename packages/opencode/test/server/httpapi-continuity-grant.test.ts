import { afterEach, describe, expect } from "bun:test"
import { WorkspaceTable } from "@newhorse/core/control-plane/workspace.sql"
import { Database } from "@newhorse/core/database/database"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { ProjectV2 } from "@newhorse/core/project"
import { ProjectTable } from "@newhorse/core/project/sql"
import { AbsolutePath } from "@newhorse/core/schema"
import { SessionSchema } from "@newhorse/core/session/schema"
import { SessionTable } from "@newhorse/core/session/sql"
import { WorkspaceV2 } from "@newhorse/core/workspace"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { ContinuityGrant } from "@/continuity-grant"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(Database.node), httpApiLayer))

const json = <A>(response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(Effect.map((value) => value as A))

const body = (value: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
})

const seed = Effect.gen(function* () {
  const test = yield* TestInstance
  const suffix = crypto.randomUUID()
  const sourceSessionID = SessionSchema.ID.make(`ses_http_source_${suffix}`)
  const otherSourceSessionID = SessionSchema.ID.make(`ses_http_other_${suffix}`)
  const destinationSessionID = SessionSchema.ID.make(`ses_http_destination_${suffix}`)
  const sourceWorkspaceID = WorkspaceV2.ID.make(`wrk_http_source_${suffix}`)
  const destinationWorkspaceID = WorkspaceV2.ID.make(`wrk_http_destination_${suffix}`)
  const sourceDirectory = AbsolutePath.make(test.directory)
  const destinationDirectory = AbsolutePath.make(`/personal/http-continuity-${suffix}`)
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
        type: "worktree",
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
        profile_id: "assistant",
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
        profile_id: "assistant",
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
        profile_id: "companion",
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

  const route = (sessionID: SessionSchema.ID) =>
    `workspace=wrk_client_spoof&directory=${encodeURIComponent("/client/spoof")}&session=${sessionID}`
  return { test, destinationSessionID, sourceSessionID, otherSourceSessionID, route }
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("continuity grant HttpApi authority", () => {
  it.instance("uses route Session ownership and preserves not-found anti-disclosure", () =>
    Effect.gen(function* () {
      const seeded = yield* seed
      const proposalResponse = yield* requestInDirectory(
        `/continuity-grant?${seeded.route(seeded.sourceSessionID)}`,
        seeded.test.directory,
        {
          method: "POST",
          ...body({
            destinationSessionID: seeded.destinationSessionID,
            purpose: "Continue the approved weekly planning context",
            summary: "The user prefers a concise weekly plan.",
            timeExpires: Date.now() + 60_000,
          }),
        },
      )
      if (proposalResponse.status !== 200) {
        const error = yield* proposalResponse.text
        return yield* Effect.die(new Error(`Continuity proposal failed (${proposalResponse.status}): ${error}`))
      }
      const grant = yield* json<ContinuityGrant.Info>(proposalResponse)
      expect(grant).toMatchObject({
        sourceSessionID: seeded.sourceSessionID,
        destinationSessionID: seeded.destinationSessionID,
        status: "proposed",
        relationshipPersistence: false,
      })

      const invalidDestination = yield* requestInDirectory(
        `/continuity-grant?${seeded.route(seeded.sourceSessionID)}`,
        seeded.test.directory,
        {
          method: "POST",
          ...body({
            destinationSessionID: "not-a-session",
            purpose: "Invalid destination",
            summary: "Must be rejected before domain handling.",
            timeExpires: Date.now() + 60_000,
          }),
        },
      )
      expect(invalidDestination.status).toBe(400)

      const missingSession = yield* requestInDirectory("/continuity-grant", seeded.test.directory)
      expect(missingSession.status).toBe(404)

      const foreignRoute = seeded.route(seeded.otherSourceSessionID)
      const foreignList = yield* requestInDirectory(`/continuity-grant?${foreignRoute}`, seeded.test.directory)
      expect(foreignList.status).toBe(200)
      expect(yield* json<ContinuityGrant.Info[]>(foreignList)).toEqual([])
      for (const suffix of ["", "/audit", "/approve", "/revoke"]) {
        const response = yield* requestInDirectory(
          `/continuity-grant/${grant.id}${suffix}?${foreignRoute}`,
          seeded.test.directory,
          suffix === "" || suffix === "/audit" ? undefined : { method: "POST" },
        )
        if (response.status !== 404) {
          const error = yield* response.text
          return yield* Effect.die(new Error(`Foreign ${suffix || "get"} failed (${response.status}): ${error}`))
        }
      }

      const sourceRoute = seeded.route(seeded.sourceSessionID)
      const approvedResponse = yield* requestInDirectory(
        `/continuity-grant/${grant.id}/approve?${sourceRoute}`,
        seeded.test.directory,
        { method: "POST" },
      )
      expect(approvedResponse.status).toBe(200)
      expect((yield* json<ContinuityGrant.Info>(approvedResponse)).status).toBe("active")

      const duplicateApproval = yield* requestInDirectory(
        `/continuity-grant/${grant.id}/approve?${sourceRoute}`,
        seeded.test.directory,
        { method: "POST" },
      )
      expect(duplicateApproval.status).toBe(409)

      const revokedResponse = yield* requestInDirectory(
        `/continuity-grant/${grant.id}/revoke?${sourceRoute}`,
        seeded.test.directory,
        { method: "POST" },
      )
      expect(revokedResponse.status).toBe(200)
      expect((yield* json<ContinuityGrant.Info>(revokedResponse)).status).toBe("revoked")

      const auditResponse = yield* requestInDirectory(
        `/continuity-grant/${grant.id}/audit?${sourceRoute}`,
        seeded.test.directory,
      )
      expect(auditResponse.status).toBe(200)
      const audit = yield* json<ContinuityGrant.AuditInfo[]>(auditResponse)
      expect(audit.map((item) => item.action)).toEqual(["proposed", "approved", "revoked"])
      expect(JSON.stringify(audit)).not.toContain(grant.purpose)
      expect(JSON.stringify(audit)).not.toContain(grant.summary)
    }),
  )
})

import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@newhorse/sdk/v2"
import {
  continuityAuditDetails,
  continuityGrantApprove,
  continuityGrantAudit,
  continuityGrantDetails,
  continuityGrantGet,
  continuityGrantList,
  continuityGrantRevoke,
  effectiveContinuityStatus,
  type ContinuityGrantAuditInfo,
  type ContinuityGrantInfo,
} from "../../src/component/dialog-continuity-grant-state"

const grant = (status: ContinuityGrantInfo["status"] = "proposed"): ContinuityGrantInfo => ({
  id: "cgr_1",
  sourceWorkspaceID: "wrk_source",
  sourceDirectory: "/source",
  sourceProfileID: "pro_assistant",
  sourceSessionID: "ses_source",
  destinationWorkspaceID: "wrk_personal",
  destinationDirectory: "/personal",
  destinationProfileID: "pro_companion",
  destinationSessionID: "ses_destination",
  purpose: "Continue planning",
  summary: "The user approved this minimized summary.",
  relationshipPersistence: false,
  timeExpires: Date.parse("2030-01-02T03:04:00Z"),
  status,
  timeCreated: 1,
  timeUpdated: 1,
})

const audit: ContinuityGrantAuditInfo = {
  id: "cga_1",
  grantID: "cgr_1",
  action: "approved",
  outcome: "success",
  destinationSessionID: "ses_destination",
  timeCreated: Date.parse("2030-01-01T00:00:00Z"),
}

describe("dialog Continuity Grant state", () => {
  test("derives expiry without changing revoked status", () => {
    expect(effectiveContinuityStatus(grant(), Date.parse("2030-01-01T00:00:00Z"))).toBe("proposed")
    expect(effectiveContinuityStatus(grant(), Date.parse("2030-01-03T00:00:00Z"))).toBe("expired")
    expect(effectiveContinuityStatus(grant("revoked"), Date.parse("2030-01-03T00:00:00Z"))).toBe("revoked")
  })

  test("formats visible authority, persistence and content-free audit", () => {
    expect(continuityGrantDetails(grant())).toEqual([
      "source pro_assistant · session ses_source",
      "source workspace wrk_source",
      "destination pro_companion · session ses_destination",
      "destination workspace wrk_personal",
      "expires 2030-01-02T03:04:00.000Z",
      "not persisted to relationship Memory",
      "summary: The user approved this minimized summary.",
    ])
    expect(continuityAuditDetails([audit])).toEqual([
      "2030-01-01T00:00:00.000Z · approved · success · destination ses_destination",
    ])
  })

  test("sends only frozen source routing and grant ID", async () => {
    const requests: Array<{ method: string; path: string; query: string }> = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, query: url.search })
      if (url.pathname.endsWith("/audit")) return Response.json([audit])
      if (url.pathname === "/continuity-grant") return Response.json([grant()])
      return Response.json(grant(request.method === "POST" ? "active" : "proposed"))
    }) as typeof globalThis.fetch
    const client = createOpencodeClient({ baseUrl: "http://continuity.test", fetch })
    const routing = { session: "ses_source", directory: "/source", workspace: "wrk_source" }

    await continuityGrantList(client, routing)
    await continuityGrantGet(client, routing, "cgr_1")
    await continuityGrantAudit(client, routing, "cgr_1")
    await continuityGrantApprove(client, routing, "cgr_1")
    await continuityGrantRevoke(client, routing, "cgr_1")

    expect(requests).toEqual([
      {
        method: "GET",
        path: "/continuity-grant",
        query: "?session=ses_source&directory=%2Fsource&workspace=wrk_source",
      },
      {
        method: "GET",
        path: "/continuity-grant/cgr_1",
        query: "?session=ses_source&directory=%2Fsource&workspace=wrk_source",
      },
      {
        method: "GET",
        path: "/continuity-grant/cgr_1/audit",
        query: "?session=ses_source&directory=%2Fsource&workspace=wrk_source",
      },
      {
        method: "POST",
        path: "/continuity-grant/cgr_1/approve",
        query: "?session=ses_source&directory=%2Fsource&workspace=wrk_source",
      },
      {
        method: "POST",
        path: "/continuity-grant/cgr_1/revoke",
        query: "?session=ses_source&directory=%2Fsource&workspace=wrk_source",
      },
    ])
  })

  test("rejects SDK responses without data", async () => {
    const failed = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ _tag: "NotFound" }, { status: 404 })) as typeof globalThis.fetch
    const client = createOpencodeClient({ baseUrl: "http://continuity.test", fetch: failed })
    await expect(
      continuityGrantAudit(
        client,
        { session: "ses_source", directory: "/source", workspace: "wrk_source" },
        "cgr_missing",
      ),
    ).rejects.toThrow("Continuity grant audit unavailable")
  })
})

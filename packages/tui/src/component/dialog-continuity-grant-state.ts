import {
  createOpencodeClient,
  type ContinuityGrantAuditResponse,
  type ContinuityGrantListResponse,
} from "@newhorse/sdk/v2"

type ContinuityClient = ReturnType<typeof createOpencodeClient>

type ClientResponse<T> = { data?: T; error?: unknown }

async function required<T>(request: Promise<ClientResponse<T>>, message: string) {
  const response = await request
  if (response.data !== undefined) return response.data
  throw new Error(message, { cause: response.error })
}

export type ContinuityGrantInfo = ContinuityGrantListResponse[number]
export type ContinuityGrantAuditInfo = ContinuityGrantAuditResponse[number]

export type ContinuityRouteSnapshot = {
  key: string
  sessionID: string
  workspaceID?: string
  directory: string
  query: {
    session: string
    directory: string
    workspace?: string
  }
}

export function effectiveContinuityStatus(item: ContinuityGrantInfo, now = Date.now()) {
  if (item.status !== "revoked" && item.timeExpires <= now) return "expired" as const
  return item.status
}

export function continuityGrantDetails(item: ContinuityGrantInfo) {
  return [
    `source ${item.sourceProfileID} · session ${item.sourceSessionID}`,
    `source workspace ${item.sourceWorkspaceID ?? "unbound"}`,
    `destination ${item.destinationProfileID} · session ${item.destinationSessionID}`,
    `destination workspace ${item.destinationWorkspaceID}`,
    `expires ${new Date(item.timeExpires).toISOString()}`,
    item.relationshipPersistence ? "relationship persistence enabled" : "not persisted to relationship Memory",
    `summary: ${item.summary}`,
  ]
}

export function continuityAuditDetails(events: ContinuityGrantAuditInfo[]) {
  return events.map((event) => {
    const destination = event.destinationSessionID ? ` · destination ${event.destinationSessionID}` : ""
    return `${new Date(event.timeCreated).toISOString()} · ${event.action} · ${event.outcome}${destination}`
  })
}

export function continuityGrantList(
  client: ContinuityClient,
  routing: ContinuityRouteSnapshot["query"],
  signal?: AbortSignal,
) {
  return required(client.continuityGrant.list(routing, { signal }), "Continuity grants unavailable")
}

export function continuityGrantGet(
  client: ContinuityClient,
  routing: ContinuityRouteSnapshot["query"],
  grantID: string,
  signal?: AbortSignal,
) {
  return required(client.continuityGrant.get({ ...routing, grantID }, { signal }), "Continuity grant unavailable")
}

export function continuityGrantAudit(
  client: ContinuityClient,
  routing: ContinuityRouteSnapshot["query"],
  grantID: string,
  signal?: AbortSignal,
) {
  return required(
    client.continuityGrant.audit({ ...routing, grantID }, { signal }),
    "Continuity grant audit unavailable",
  )
}

export function continuityGrantApprove(
  client: ContinuityClient,
  routing: ContinuityRouteSnapshot["query"],
  grantID: string,
) {
  return required(client.continuityGrant.approve({ ...routing, grantID }), "Continuity grant approval failed")
}

export function continuityGrantRevoke(
  client: ContinuityClient,
  routing: ContinuityRouteSnapshot["query"],
  grantID: string,
) {
  return required(client.continuityGrant.revoke({ ...routing, grantID }), "Continuity grant revocation failed")
}

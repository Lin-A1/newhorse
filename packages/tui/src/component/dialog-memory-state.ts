import { createOpencodeClient, type MemoryInfo } from "@newhorse/sdk/v2"

type MemoryClient = ReturnType<typeof createOpencodeClient>

type ClientResponse<T> = { data?: T; error?: unknown }

async function required<T>(request: Promise<ClientResponse<T>>, message: string) {
  const response = await request
  if (response.data !== undefined) return response.data
  throw new Error(message, { cause: response.error })
}

export type MemoryDialogValue = { type: "record"; item: MemoryInfo } | { type: "load-more" } | { type: "manage" }

export function memoryDetails(item: MemoryInfo) {
  const source = item.sourceMessageID
    ? `message ${item.sourceMessageID}`
    : item.sourceSessionID
      ? `session ${item.sourceSessionID}`
      : "direct"
  return [
    `${item.kind} · ${item.scope.replaceAll("_", "-")} · ${item.provenance.replaceAll("_", " ")}`,
    source,
    ...(item.timeExpires ? [`expires ${new Date(item.timeExpires).toISOString()}`] : []),
  ]
}

export function mergeMemoryPage(current: MemoryInfo[], incoming: MemoryInfo[]) {
  const next = new Map(current.map((item) => [item.id, item]))
  incoming.forEach((item) => next.set(item.id, item))
  return [...next.values()]
}

export type MemoryRouting = { session?: string }

export function memoryClearTargets(personal: boolean) {
  return ["workspace", ...(personal ? (["relationship"] as const) : []), "user_global"] as const
}

export function memoryDecide(
  client: MemoryClient,
  routing: MemoryRouting,
  item: MemoryInfo,
  decision: "accept" | "reject",
) {
  return required(
    client.memory.decide({ ...routing, memoryID: item.id, scope: item.scope, decision }),
    "Memory decision failed",
  )
}

export function memoryPause(client: MemoryClient, routing: MemoryRouting, item: MemoryInfo, paused: boolean) {
  return required(
    client.memory.pause({ ...routing, memoryID: item.id, scope: item.scope, paused }),
    "Memory pause failed",
  )
}

export function memoryUpdate(
  client: MemoryClient,
  routing: MemoryRouting,
  item: MemoryInfo,
  input: { content: string; kind: MemoryInfo["kind"]; expiresAt: number | null },
) {
  return required(
    client.memory.update({
      ...routing,
      memoryID: item.id,
      scope: item.scope,
      content: input.content,
      kind: input.kind,
      expiresAt: input.expiresAt ?? undefined,
      clearExpiry: input.expiresAt === null ? true : undefined,
    }),
    "Memory update failed",
  )
}

export function memoryRemove(client: MemoryClient, routing: MemoryRouting, item: MemoryInfo) {
  return required(client.memory.remove({ ...routing, memoryID: item.id, scope: item.scope }), "Memory delete failed")
}

export function memoryClear(
  client: MemoryClient,
  routing: MemoryRouting,
  target: "workspace" | "relationship" | "user_global",
) {
  return required(client.memory.clear({ ...routing, target }), "Memory clear failed")
}

export function parseExpiry(value: string) {
  const input = value.trim()
  if (!input) return null
  const time = new Date(input).getTime()
  if (!Number.isFinite(time)) throw new Error("Expiry must be an ISO date/time or blank")
  return time
}

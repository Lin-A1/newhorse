import type { MemoryInfo } from "@newhorse/sdk/v2"
import { useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

export type MemoryKind = MemoryInfo["kind"]
export type MemoryScope = MemoryInfo["scope"]
export type MemoryStatus = MemoryInfo["status"]

type ClientResponse<T> = { data?: T; error?: unknown }

function required<T>(response: ClientResponse<T>, message: string) {
  if (response.data !== undefined) return response.data
  throw new Error(message, { cause: response.error })
}

type ServerSDK = ReturnType<ReturnType<typeof useServerSDK>>
type ScopedSource = {
  key: string
  routing: { workspace?: string; session?: string; directory?: string }
  client: ReturnType<ServerSDK["createClient"]>
}

export function useMemoryCenterState(sessionID?: string) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const params = useParams<{ id?: string }>()
  const id = createMemo(() => params.id ?? sessionID)
  const session = createMemo(() => {
    const value = id()
    return value ? serverSync().session.get(value) : undefined
  })
  createEffect(() => {
    const value = id()
    if (!value || session()) return
    void serverSync().session.resolve(value).catch(() => undefined)
  })
  const source = createMemo((): ScopedSource | undefined => {
    const sessionID = id()
    const current = session()
    if (sessionID && !current) return
    const scopedClient = current
      ? serverSDK().createClient({
          directory: current.directory,
          experimental_workspaceID: current.workspaceID,
          throwOnError: true,
        })
      : serverSDK().client
    return {
      key: sessionID ? `session:${sessionID}:${current!.directory}:${current!.workspaceID}` : "home",
      routing: {
        ...(current?.workspaceID ? { workspace: current.workspaceID } : {}),
        ...(sessionID ? { session: sessionID } : {}),
      },
      client: scopedClient,
    }
  })
  const [state, setState] = createStore({
    items: [] as MemoryInfo[],
    nextCursor: undefined as string | undefined,
    loadingMore: false,
    mutating: undefined as string | undefined,
    contentScope: undefined as "project" | "personal" | undefined,
  })

  const query = (current: NonNullable<ReturnType<typeof source>>, cursor?: string) => ({
    ...current.routing,
    includeGlobal: "true" as const,
    limit: "50",
    ...(cursor ? { cursor } : {}),
  })

  const [activeSource, setActiveSource] = createSignal<NonNullable<ReturnType<typeof source>>>()

  const sameSource = (
    left: NonNullable<ReturnType<typeof source>> | undefined,
    right: NonNullable<ReturnType<typeof source>> | undefined,
  ) => left?.key === right?.key

  const [ready, actions] = createResource(source, async (current) => {
    const [capabilityResponse, pageResponse] = await Promise.all([
      current.client.capability.get(),
      current.client.memory.list(query(current)),
    ])
    const capability = required(capabilityResponse, "Capability state unavailable")
    const page = required(pageResponse, "Memory response unavailable")
    return { source: current, page, contentScope: capability.workspace.contentScope }
  })

  createEffect(() => {
    source()
    setActiveSource(undefined)
    setState("items", [])
    setState("nextCursor", undefined)
    setState("loadingMore", false)
    setState("contentScope", undefined)
    setState("mutating", undefined)
  })

  createEffect(() => {
    const result = ready()
    if (!result || !sameSource(source(), result.source)) return
    setActiveSource(result.source)
    setState("contentScope", result.contentScope)
    setState("items", reconcile(result.page.items, { key: "id" }))
    setState("nextCursor", result.page.nextCursor)
  })

  const refresh = async () => {
    await actions.refetch()
  }

  const current = () => {
    const value = activeSource()
    if (!value || !sameSource(source(), value)) throw new Error("Session scope is not ready")
    return value
  }

  const reload = async (scoped: NonNullable<ReturnType<typeof source>>) => {
    const page = required(await scoped.client.memory.list(query(scoped)), "Memory response unavailable")
    if (!sameSource(source(), scoped) || !sameSource(activeSource(), scoped)) return
    setState("items", reconcile(page.items, { key: "id" }))
    setState("nextCursor", page.nextCursor)
  }

  const mutate = async <T>(key: string, action: () => Promise<T>) => {
    setState("mutating", key)
    try {
      return await action()
    } finally {
      if (state.mutating === key) setState("mutating", undefined)
    }
  }

  const replace = (scoped: NonNullable<ReturnType<typeof source>>, item: MemoryInfo) => {
    if (!sameSource(source(), scoped) || !sameSource(activeSource(), scoped)) return
    if (!state.items.some((current) => current.id === item.id)) return
    if (item.status === "rejected" || item.status === "deleted") {
      setState("items", (items) => items.filter((current) => current.id !== item.id))
      return
    }
    setState("items", (current) => current.id === item.id, reconcile(item))
  }

  // Route a mutation to the workspace that owns a record. The Memory Center
  // "all" view lists rows from every workspace, but the backend scopes
  // mutations to the request's routed workspace — so records that are not part
  // of the currently loaded page get their own client pointing at their
  // workspaceID (or, for legacy directory-scoped rows, their directory).
  // Records from the current page reuse the active client so the "current"
  // view stays in sync after an edit.
  const clientFor = (item: MemoryInfo) => {
    const base = current()
    if (!state.items.some((current) => current.id === item.id)) {
      if (item.workspaceID) {
        return {
          key: `item:${item.workspaceID}`,
          routing: { workspace: item.workspaceID },
          client: serverSDK().createClient({
            experimental_workspaceID: item.workspaceID,
            throwOnError: true,
          }),
        }
      }
      if (item.directory) {
        return {
          key: `item:dir:${item.directory}`,
          routing: { directory: item.directory },
          client: serverSDK().createClient({
            directory: item.directory,
            throwOnError: true,
          }),
        }
      }
    }
    return base
  }

  return {
    state,
    ready,
    loading: () => !activeSource() || !sameSource(source(), activeSource()) || ready.loading,
    aggregateReady: () => !!activeSource() && sameSource(source(), activeSource()),
    contentScope: () => state.contentScope,
    currentWorkspaceID: () => activeSource()?.routing.workspace,
    refresh,
    async loadMore() {
      const scoped = current()
      const cursor = state.nextCursor
      if (!cursor || state.loadingMore) return
      setState("loadingMore", true)
      try {
        const page = required(
          await scoped.client.memory.list(query(scoped, cursor)),
          "Memory page response unavailable",
        )
        if (!sameSource(source(), scoped) || !sameSource(activeSource(), scoped)) return
        setState("items", reconcile([...state.items, ...page.items], { key: "id" }))
        setState("nextCursor", page.nextCursor)
      } finally {
        if (sameSource(source(), scoped)) setState("loadingMore", false)
      }
    },
    decide(item: MemoryInfo, decision: "accept" | "reject") {
      const scoped = clientFor(item)
      return mutate(item.id, async () => {
        const value = required(
          await scoped.client.memory.decide({
            ...scoped.routing,
            memoryID: item.id,
            scope: item.scope,
            decision,
          }),
          "Memory decision failed",
        )
        replace(scoped, value)
        return value
      })
    },
    update(item: MemoryInfo, input: { content: string; kind: MemoryKind; expiresAt?: number | null }) {
      const scoped = clientFor(item)
      return mutate(item.id, async () => {
        const value = required(
          await scoped.client.memory.update({
            ...scoped.routing,
            memoryID: item.id,
            scope: item.scope,
            content: input.content,
            kind: input.kind,
            expiresAt: input.expiresAt ?? undefined,
            clearExpiry: input.expiresAt === null ? true : undefined,
          }),
          "Memory update failed",
        )
        replace(scoped, value)
        return value
      })
    },
    pause(item: MemoryInfo, paused: boolean) {
      const scoped = clientFor(item)
      return mutate(item.id, async () => {
        const value = required(
          await scoped.client.memory.pause({
            ...scoped.routing,
            memoryID: item.id,
            scope: item.scope,
            paused,
          }),
          "Memory pause failed",
        )
        replace(scoped, value)
        return value
      })
    },
    remove(item: MemoryInfo) {
      const scoped = clientFor(item)
      return mutate(item.id, async () => {
        const removed = required(
          await scoped.client.memory.remove({
            ...scoped.routing,
            memoryID: item.id,
            scope: item.scope,
          }),
          "Memory delete failed",
        )
        if (removed !== true) throw new Error("Memory delete failed")
        if (sameSource(source(), scoped) && sameSource(activeSource(), scoped)) {
          setState("items", (items) => items.filter((current) => current.id !== item.id))
        }
        return true
      })
    },
    clear(target: "workspace" | "relationship" | "user_global", workspaceID?: string, directory?: string) {
      const base = current()
      const scoped = workspaceID
        ? {
            key: `clear:${workspaceID}`,
            routing: { workspace: workspaceID },
            client: serverSDK().createClient({
              experimental_workspaceID: workspaceID,
              throwOnError: true,
            }),
          }
        : directory
          ? {
              key: `clear:dir:${directory}`,
              routing: { directory },
              client: serverSDK().createClient({
                directory,
                throwOnError: true,
              }),
            }
          : base
      return mutate(`clear:${target}`, async () => {
        const result = required(
          await scoped.client.memory.clear({ ...scoped.routing, target }),
          "Memory clear failed",
        )
        await reload(scoped)
        return result
      })
    },
    async exportRecords() {
      const scoped = current()
      return required(
        await scoped.client.memory.export({ ...scoped.routing, includeGlobal: "true" }),
        "Memory export failed",
      )
    },
    async history(item: MemoryInfo) {
      const scoped = clientFor(item)
      return required(
        await scoped.client.memory.history({ ...scoped.routing, memoryID: item.id }),
        "Memory history failed",
      )
    },
    async aggregate() {
      const scoped = current()
      return required(await scoped.client.memory.all({ ...scoped.routing }), "Memory aggregate failed")
    },
  }
}

import type { ContinuityGrantAuditResponse, ContinuityGrantListResponse } from "@newhorse/sdk/v2"
import { useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

export type ContinuityGrantInfo = ContinuityGrantListResponse[number]
export type ContinuityGrantAuditInfo = ContinuityGrantAuditResponse[number]

type ClientResponse<T> = { data?: T; error?: unknown }

function required<T>(response: ClientResponse<T>, message: string) {
  if (response.data !== undefined) return response.data
  throw new Error(message, { cause: response.error })
}

export function effectiveContinuityStatus(item: ContinuityGrantInfo, now = Date.now()) {
  if (item.status !== "revoked" && item.timeExpires <= now) return "expired" as const
  return item.status
}

export function useContinuityGrantState(sessionID?: string) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const params = useParams<{ id?: string }>()
  const id = createMemo(() => sessionID ?? params.id)
  const session = createMemo(() => {
    const value = id()
    return value ? serverSync().session.get(value) : undefined
  })
  const source = createMemo(() => {
    const sessionID = id()
    if (!sessionID) return
    const current = session()
    if (!current) return
    return {
      key: `${sessionID}:${current.directory}:${current.workspaceID ?? ""}`,
      routing: {
        session: sessionID,
        ...(current.workspaceID ? { workspace: current.workspaceID } : {}),
      },
      client: serverSDK().createClient({
        directory: current.directory,
        experimental_workspaceID: current.workspaceID,
        throwOnError: true,
      }),
    }
  })
  const [activeSource, setActiveSource] = createSignal<NonNullable<ReturnType<typeof source>>>()
  const [state, setState] = createStore({
    items: [] as ContinuityGrantInfo[],
    audit: {} as Record<string, ContinuityGrantAuditInfo[] | undefined>,
    loadingAudit: undefined as string | undefined,
    mutating: undefined as string | undefined,
  })

  const sameSource = (
    left: NonNullable<ReturnType<typeof source>> | undefined,
    right: NonNullable<ReturnType<typeof source>> | undefined,
  ) => left?.key === right?.key

  const [ready, actions] = createResource(source, async (current) => ({
    source: current,
    items: required(await current.client.continuityGrant.list(current.routing), "Continuity grants unavailable"),
  }))

  createEffect(() => {
    source()
    setActiveSource(undefined)
    setState("items", [])
    setState("audit", {})
    setState("loadingAudit", undefined)
    setState("mutating", undefined)
  })

  createEffect(() => {
    const result = ready()
    if (!result || !sameSource(source(), result.source)) return
    setActiveSource(result.source)
    setState("items", reconcile(result.items, { key: "id" }))
  })

  const current = (item?: ContinuityGrantInfo) => {
    const scoped = activeSource()
    if (!scoped || !sameSource(source(), scoped)) throw new Error("Source session is not ready")
    if (item && !state.items.some((value) => value.id === item.id)) throw new Error("Continuity grant is stale")
    return scoped
  }

  const replace = (scoped: NonNullable<ReturnType<typeof source>>, item: ContinuityGrantInfo) => {
    if (!sameSource(source(), scoped) || !sameSource(activeSource(), scoped)) return
    setState("items", (value) => value.id === item.id, reconcile(item))
  }

  const mutate = async (item: ContinuityGrantInfo, action: "approve" | "revoke") => {
    const scoped = current(item)
    setState("mutating", item.id)
    try {
      const response = await scoped.client.continuityGrant[action]({ ...scoped.routing, grantID: item.id })
      const value = required(response, `Continuity grant ${action} failed`)
      replace(scoped, value)
      return value
    } finally {
      if (state.mutating === item.id) setState("mutating", undefined)
    }
  }

  return {
    state,
    ready,
    loading: () => !!id() && (!activeSource() || !sameSource(source(), activeSource()) || ready.loading),
    available: () => !!id(),
    async refresh() {
      await actions.refetch()
    },
    approve(item: ContinuityGrantInfo) {
      if (effectiveContinuityStatus(item) !== "proposed") throw new Error("Only unexpired proposals can be approved")
      return mutate(item, "approve")
    },
    revoke(item: ContinuityGrantInfo) {
      if (effectiveContinuityStatus(item) === "revoked") throw new Error("Continuity grant is already revoked")
      return mutate(item, "revoke")
    },
    async loadAudit(item: ContinuityGrantInfo) {
      const scoped = current(item)
      setState("loadingAudit", item.id)
      try {
        const audit = required(
          await scoped.client.continuityGrant.audit({ ...scoped.routing, grantID: item.id }),
          "Continuity grant audit unavailable",
        )
        if (!sameSource(source(), scoped) || !sameSource(activeSource(), scoped)) return
        setState("audit", item.id, reconcile(audit, { key: "id" }))
        return audit
      } finally {
        if (state.loadingAudit === item.id) setState("loadingAudit", undefined)
      }
    },
  }
}

import type { ReminderAuditResponses } from "@newhorse/sdk/v2"
import { useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import {
  markReminderCancelled,
  normalizeReminder,
  reconcileReminder,
  type NormalizedReminderInfo,
  type ReminderInfo,
} from "./settings-reminders-helpers"

export type { NormalizedReminderInfo as ReminderInfo } from "./settings-reminders-helpers"

export type ReminderRouting = Readonly<{
  workspace?: string
  session?: string
}>

export type ReminderCreateInput = {
  type: ReminderInfo["type"]
  title: string
  body: string
  scheduleAt: number
  timezone: string
  recurrenceRule?: string
  misfirePolicy: NormalizedReminderInfo["misfirePolicy"]
}

export type ReminderUpdateInput = {
  title?: string
  body?: string
  scheduleAt?: number
  timezone?: string
  recurrenceRule?: string
  clearRecurrence?: boolean
  misfirePolicy?: ReminderInfo["misfirePolicy"]
  paused?: boolean
}

type ClientResponse<T> = { data?: T; error?: unknown }
type ReminderAuditPage = ReminderAuditResponses[200]
type ReminderClient = {
  list(input: ReminderRouting): Promise<ClientResponse<ReminderInfo[]>>
  create(input: ReminderRouting & ReminderCreateInput): Promise<ClientResponse<ReminderInfo>>
  update(input: ReminderRouting & ReminderUpdateInput & { reminderID: string }): Promise<ClientResponse<ReminderInfo>>
  cancel(input: ReminderRouting & { reminderID: string }): Promise<ClientResponse<boolean>>
  audit(input: ReminderRouting & { reminderID: string; limit?: string; cursor?: string }): Promise<ClientResponse<ReminderAuditPage>>
}

type ReminderSource = Readonly<{
  key: string
  directory?: string
  workspaceID?: string
  sessionID?: string
  routing: ReminderRouting
  client: ReminderClient
}>

function required<T>(response: ClientResponse<T>, message: string) {
  if (response.data !== undefined) return response.data
  throw new Error(message, { cause: response.error })
}

export function useReminderState(sessionID?: string) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const params = useParams<{ id?: string }>()
  const id = createMemo(() => sessionID ?? params.id)
  const session = createMemo(() => {
    const value = id()
    return value ? serverSync().session.get(value) : undefined
  })
  const source = createMemo<ReminderSource | undefined>(() => {
    const sourceSessionID = id()
    const current = session()
    if (sourceSessionID && !current) return
    const sdk = current
      ? serverSDK().createClient({
          directory: current.directory,
          experimental_workspaceID: current.workspaceID,
          throwOnError: true,
        })
      : serverSDK().client
    const routing = Object.freeze({
      ...(current?.workspaceID ? { workspace: current.workspaceID } : {}),
      ...(sourceSessionID ? { session: sourceSessionID } : {}),
    })
    return Object.freeze({
      key: sourceSessionID
        ? `session:${sourceSessionID}:${current!.directory}:${current!.workspaceID ?? ""}`
        : "home",
      directory: current?.directory,
      workspaceID: current?.workspaceID,
      sessionID: sourceSessionID,
      routing,
      client: sdk.reminder,
    })
  })
  const [activeSource, setActiveSource] = createSignal<ReminderSource>()
  const [state, setState] = createStore({
    items: [] as NormalizedReminderInfo[],
    mutating: undefined as string | undefined,
  })

  const sameSource = (left: ReminderSource | undefined, right: ReminderSource | undefined) => left?.key === right?.key

  const [ready, actions] = createResource(source, async (current) => ({
    source: current,
    items: required(await current.client.list(current.routing), "Reminder response unavailable").map(normalizeReminder),
  }))

  createEffect(() => {
    source()
    setActiveSource(undefined)
    setState("items", [])
    setState("mutating", undefined)
  })

  createEffect(() => {
    const result = ready()
    if (!result || !sameSource(source(), result.source)) return
    setActiveSource(result.source)
    setState("items", reconcile(result.items, { key: "id" }))
  })

  const current = (item?: NormalizedReminderInfo) => {
    const scoped = activeSource()
    if (!scoped || !sameSource(source(), scoped)) throw new Error("Reminder scope is not ready")
    if (item && !state.items.some((value) => value.id === item.id)) throw new Error("Reminder is stale")
    return scoped
  }

  const mutate = async <T>(key: string, action: () => Promise<T>) => {
    setState("mutating", key)
    try {
      return await action()
    } finally {
      if (state.mutating === key) setState("mutating", undefined)
    }
  }

  const replace = (scoped: ReminderSource, item: ReminderInfo) => {
    if (!sameSource(source(), scoped) || !sameSource(activeSource(), scoped)) return
    setState("items", reconcile(reconcileReminder(state.items, item), { key: "id" }))
  }

  const update = (item: NormalizedReminderInfo, input: ReminderUpdateInput) => {
    const scoped = current(item)
    return mutate(item.id, async () => {
      const value = required(
        await scoped.client.update({ ...scoped.routing, reminderID: item.id, ...input }),
        "Reminder update failed",
      )
      replace(scoped, normalizeReminder(value))
      return value
    })
  }

  return {
    state,
    ready,
    loading: () => ready.loading || (!ready.error && (!activeSource() || !sameSource(source(), activeSource()))),
    error: () => ready.error,
    async refresh() {
      await actions.refetch()
    },
    create(input: ReminderCreateInput) {
      const scoped = current()
      return mutate("create", async () => {
        const item = required(
          await scoped.client.create({ ...scoped.routing, ...input }),
          "Reminder creation failed",
        )
        replace(scoped, normalizeReminder(item))
        return item
      })
    },
    update,
    pause(item: NormalizedReminderInfo, paused: boolean) {
      return update(item, { paused })
    },
    async audit(item: NormalizedReminderInfo, cursor?: string) {
      const scoped = current(item)
      return required(
        await scoped.client.audit({ ...scoped.routing, reminderID: item.id, limit: "50", cursor }),
        "Reminder audit failed",
      )
    },
    cancel(item: NormalizedReminderInfo) {
      const scoped = current(item)
      return mutate(item.id, async () => {
        const cancelled = required(
          await scoped.client.cancel({ ...scoped.routing, reminderID: item.id }),
          "Reminder cancellation failed",
        )
        if (!cancelled) throw new Error("Reminder cancellation failed")
        if (sameSource(source(), scoped) && sameSource(activeSource(), scoped)) {
          setState("items", reconcile(markReminderCancelled(state.items, item.id), { key: "id" }))
        }
        return true
      })
    },
  }
}

import type { ReminderListResponses } from "@newhorse/sdk/v2"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import {
  normalizeReminderRule,
  parseReminderSchedule,
  reminderAudit,
  reminderCancel,
  reminderCreate,
  reminderDetails,
  reminderPause,
  reminderUpdate,
  type ReminderDialogValue,
  type ReminderInfo,
  type ReminderRouting,
} from "./dialog-reminder-state"

type ReminderClient = ReturnType<ReturnType<typeof useSDK>["clientFor"]>["reminder"]
type RouteSnapshot = { key: string; query: ReminderRouting; workspaceID?: string }
type Routing = RouteSnapshot & { client: ReminderClient }

export function DialogReminder() {
  const sdk = useSDK()
  const project = useProject()
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  const [store, setStore] = createStore({ items: [] as ReminderInfo[] })
  const [loading, setLoading] = createSignal(true)
  const [mutating, setMutating] = createSignal(false)
  let generation = 0
  let activeRoute: RouteSnapshot | undefined

  const routeSnapshot = (): RouteSnapshot | undefined => {
    const current = route.data
    if (current.type === "session") {
      const session = sync.session.get(current.sessionID)
      if (!session) return
      return {
        key: `session:${current.sessionID}:${session.directory}:${session.workspaceID ?? ""}:${session.profileID ?? ""}`,
        query: { session: current.sessionID },
        workspaceID: session.workspaceID,
      }
    }
    const workspaceID = project.workspace.current()
    return { key: `${current.type}:${workspaceID ?? ""}`, query: {}, workspaceID }
  }

  const routing = (): Routing | undefined => {
    const current = routeSnapshot()
    if (!current || current.key !== activeRoute?.key) return
    return { ...current, client: sdk.clientFor(current.workspaceID).reminder }
  }

  const load = async (snapshot: RouteSnapshot) => {
    const request = ++generation
    setLoading(true)
    try {
      const response = await sdk
        .clientFor(snapshot.workspaceID)
        .reminder.list(snapshot.query, { signal: controller.signal })
      if (!response.data) throw new Error("Reminder response unavailable")
      if (request !== generation || routeSnapshot()?.key !== snapshot.key) return
      activeRoute = snapshot
      setStore("items", reconcile(response.data, { key: "id" }))
    } catch (error) {
      if (!controller.signal.aborted && request === generation) toast.error(error)
    } finally {
      if (request === generation) setLoading(false)
    }
  }

  onMount(() => dialog.setSize("xlarge"))

  createEffect(() => {
    const current = routeSnapshot()
    activeRoute = undefined
    setStore("items", [])
    if (!current) {
      generation++
      setLoading(true)
      return
    }
    void load(current)
  })

  const options = createMemo<DialogSelectOption<ReminderDialogValue>[]>(() => [
    ...store.items.map((item) => ({
      value: { type: "record", item } as const,
      title: item.title,
      description: item.status,
      details: reminderDetails(item),
      category: item.status,
      truncateTitle: true as const,
    })),
    {
      value: { type: "create" } as const,
      title: "Create reminder",
      description: "Schedule a one-shot or recurring reminder",
      category: "Actions",
    },
  ])

  const isCurrent = (current: RouteSnapshot) => routeSnapshot()?.key === current.key
  const owns = (current: RouteSnapshot, revision: number) => isCurrent(current) && dialog.revision === revision
  const reopen = () => dialog.replace(() => <DialogReminder />)

  const replace = (current: Routing, item: ReminderInfo) => {
    if (!isCurrent(current)) return
    setStore("items", (value) => value.id === item.id, reconcile(item))
  }

  const run = async (current: Routing, action: () => Promise<void>) => {
    if (mutating()) return
    setMutating(true)
    try {
      await action()
    } catch (error) {
      if (isCurrent(current)) toast.show({ title: "Reminder request failed", message: errorMessage(error), variant: "error" })
    } finally {
      setMutating(false)
    }
  }

  const promptFields = async (current: Routing, item?: ReminderInfo) => {
    const prompt = (title: string, options: Parameters<typeof DialogPrompt.show>[2]) => {
      const result = DialogPrompt.show(dialog, title, options)
      const revision = dialog.revision
      return result.then((value) => ({ value, revision }))
    }
    const title = await prompt("Reminder title", { value: item?.title ?? "" })
    if (!owns(current, title.revision) || title.value === null) return
    const body = await prompt("Reminder body", { value: item?.body ?? "" })
    if (!owns(current, body.revision) || body.value === null) return
    const schedule = await prompt("Reminder schedule", {
      value: item ? new Date(item.scheduleAt).toISOString() : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      placeholder: "ISO date/time",
    })
    if (!owns(current, schedule.revision) || schedule.value === null) return
    const timezone = await prompt("Reminder timezone", { value: item?.timezone ?? "UTC" })
    if (!owns(current, timezone.revision) || timezone.value === null) return
    const recurrence = await prompt("Reminder recurrence", {
      value: item?.recurrenceRule ?? "",
      placeholder: "Blank, FREQ=DAILY, or FREQ=WEEKLY;INTERVAL=2",
    })
    if (!owns(current, recurrence.revision) || recurrence.value === null) return
    return {
      input: {
        title: title.value.trim(),
        body: body.value.trim(),
        scheduleAt: parseReminderSchedule(schedule.value),
        timezone: timezone.value.trim(),
        recurrenceRule: normalizeReminderRule(recurrence.value),
        misfirePolicy: item?.misfirePolicy ?? ("catch_up_once" as const),
      },
      revision: recurrence.revision,
    }
  }

  const create = async () => {
    const current = routing()
    if (!current) return
    let flowRevision = dialog.revision
    try {
      const fields = await promptFields(current)
      if (!fields || !owns(current, fields.revision)) return
      flowRevision = fields.revision
      const item = await reminderCreate(current.client, current.query, fields.input)
      if (owns(current, flowRevision)) toast.show({ message: `Created reminder ${item.id}`, variant: "success" })
    } catch (error) {
      if (owns(current, flowRevision))
        toast.show({ title: "Reminder creation failed", message: errorMessage(error), variant: "error" })
    }
    if (owns(current, flowRevision)) reopen()
  }

  const edit = async (item: ReminderInfo) => {
    const current = routing()
    if (!current) return
    let flowRevision = dialog.revision
    try {
      const fields = await promptFields(current, item)
      if (!fields || !owns(current, fields.revision)) return
      flowRevision = fields.revision
      await reminderUpdate(current.client, current.query, item, fields.input)
      if (owns(current, flowRevision)) toast.show({ message: "Reminder updated", variant: "success" })
    } catch (error) {
      if (owns(current, flowRevision))
        toast.show({ title: "Reminder update failed", message: errorMessage(error), variant: "error" })
    }
    if (owns(current, flowRevision)) reopen()
  }

  const pause = (item: ReminderInfo) => {
    const current = routing()
    if (!current) return
    void run(current, async () => replace(current, await reminderPause(current.client, current.query, item, item.status !== "paused")))
  }

  const showAudit = async (item: ReminderInfo) => {
    const current = routing()
    if (!current) return
    const flowRevision = dialog.revision
    try {
      const page = await reminderAudit(current.client, current.query, item)
      if (!owns(current, flowRevision)) return
      let auditRevision = 0
      dialog.replace(
        () => (
          <DialogSelect
            title={`Reminder audit · ${item.title}`}
            options={page.items.map((entry) => ({
              value: entry.id,
              title: `${entry.action} · ${entry.outcome}`,
              description: new Date(entry.timeCreated).toISOString(),
              details: [entry.deliveryKey, entry.reason].filter((value): value is string => value !== undefined),
            }))}
          />
        ),
        () => {
          if (owns(current, auditRevision)) reopen()
        },
      )
      auditRevision = dialog.revision
    } catch (error) {
      if (owns(current, flowRevision))
        toast.show({ title: "Reminder audit failed", message: errorMessage(error), variant: "error" })
    }
  }

  const cancel = async (item: ReminderInfo) => {
    const current = routing()
    if (!current) return
    const confirmation = DialogConfirm.show(dialog, "Cancel reminder", "Future delivery or recurrence will stop.", "cancel")
    const confirmRevision = dialog.revision
    const confirmed = await confirmation
    if (!isCurrent(current) || dialog.revision !== confirmRevision + 1 || !confirmed) return
    const mutationRevision = dialog.revision
    try {
      const cancelled = await reminderCancel(current.client, current.query, item)
      if (!owns(current, mutationRevision)) return
      if (!cancelled) throw new Error("Reminder is not cancellable")
      toast.show({ message: "Reminder cancelled", variant: "success" })
    } catch (error) {
      if (owns(current, mutationRevision))
        toast.show({ title: "Reminder cancellation failed", message: errorMessage(error), variant: "error" })
    }
  }

  const record = (option: DialogSelectOption<ReminderDialogValue> | undefined) =>
    option?.value.type === "record" ? option.value.item : undefined

  return (
    <DialogSelect
      title="Reminders"
      placeholder="Search reminders"
      options={loading() ? [] : options()}
      locked={loading() || mutating()}
      preserveSelection
      emptyView={<text>{loading() ? "Loading reminders…" : "No reminders."}</text>}
      actions={[
        {
          command: "dialog.reminder.edit",
          title: "edit",
          disabled: (option) => !record(option),
          onTrigger: (option) => void edit(record(option)!),
        },
        {
          command: "dialog.reminder.pause",
          title: "pause/resume",
          disabled: (option) => {
            const item = record(option)
            return !item?.recurrenceRule || (item.status !== "pending" && item.status !== "paused")
          },
          onTrigger: (option) => pause(record(option)!),
        },
        {
          command: "dialog.reminder.audit",
          title: "audit",
          disabled: (option) => !record(option),
          onTrigger: (option) => void showAudit(record(option)!),
        },
        {
          command: "dialog.reminder.cancel",
          title: "cancel",
          disabled: (option) => {
            const status = record(option)?.status
            return !status || status === "cancelled" || status === "delivered" || status === "failed"
          },
          onTrigger: (option) => void cancel(record(option)!),
        },
      ]}
      onSelect={(option) => {
        if (option.value.type === "create") void create()
      }}
    />
  )
}

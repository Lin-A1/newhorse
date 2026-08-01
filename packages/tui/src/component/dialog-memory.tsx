import type { CapabilityCurrent, MemoryInfo } from "@newhorse/sdk/v2"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useClipboard } from "../context/clipboard"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast, type ToastContext } from "../ui/toast"
import { errorMessage } from "../util/error"
import {
  memoryClear,
  memoryClearTargets,
  memoryDecide,
  memoryDetails,
  memoryPause,
  memoryRemove,
  memoryUpdate,
  mergeMemoryPage,
  parseExpiry,
  type MemoryDialogValue,
  type MemoryRouting,
} from "./dialog-memory-state"

const kinds: MemoryInfo["kind"][] = ["preference", "fact", "goal", "event", "relationship", "summary"]

type MemoryClient = ReturnType<ReturnType<typeof useSDK>["clientFor"]>
type RouteSnapshot = { key: string; query: MemoryRouting; workspaceID?: string }
type Routing = RouteSnapshot & { client: MemoryClient; personal: boolean }

export function DialogMemory() {
  const sdk = useSDK()
  const project = useProject()
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const clipboard = useClipboard()
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  const [store, setStore] = createStore({
    items: [] as MemoryInfo[],
    nextCursor: undefined as string | undefined,
    capability: undefined as CapabilityCurrent | undefined,
  })
  const [loading, setLoading] = createSignal(true)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [mutating, setMutating] = createSignal(false)
  const [toDelete, setToDelete] = createSignal<string>()
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
    return {
      ...current,
      client: sdk.clientFor(current.workspaceID),
      personal: store.capability?.workspace.contentScope === "personal",
    }
  }

  const load = async (snapshot: RouteSnapshot, cursor?: string) => {
    if (cursor && loadingMore()) return
    const request = ++generation
    if (cursor) setLoadingMore(true)
    else setLoading(true)
    try {
      const client = sdk.clientFor(snapshot.workspaceID)
      const capabilityRequest =
        activeRoute?.key === snapshot.key && store.capability
          ? Promise.resolve(store.capability)
          : client.capability.get(snapshot.query, { signal: controller.signal }).then((result) => result.data)
      const [capability, page] = await Promise.all([
        capabilityRequest,
        client.memory
          .list({ ...snapshot.query, includeGlobal: "true", limit: "50", cursor }, { signal: controller.signal })
          .then((result) => result.data),
      ])
      if (!capability) throw new Error("Capability state unavailable")
      if (!page) throw new Error("Memory response unavailable")
      if (request !== generation || routeSnapshot()?.key !== snapshot.key) return
      activeRoute = snapshot
      setStore("capability", capability)
      setStore("items", reconcile(cursor ? mergeMemoryPage(store.items, page.items) : page.items, { key: "id" }))
      setStore("nextCursor", page.nextCursor)
    } catch (error) {
      if (!controller.signal.aborted && request === generation) toast.error(error)
    } finally {
      if (request === generation) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  onMount(() => dialog.setSize("xlarge"))

  createEffect(() => {
    const current = routeSnapshot()
    activeRoute = undefined
    setStore("items", [])
    setStore("nextCursor", undefined)
    setStore("capability", undefined)
    setLoadingMore(false)
    if (!current) {
      generation++
      setLoading(true)
      return
    }
    void load(current)
  })

  const options = createMemo<DialogSelectOption<MemoryDialogValue>[]>(() => {
    if (loading()) return []
    return [
      ...store.items.map((item) => ({
        value: { type: "record", item } as const,
        title: item.content,
        description: item.status,
        details: memoryDetails(item),
        category: item.status,
        truncateTitle: true as const,
      })),
      ...(store.nextCursor
        ? [
            {
              value: { type: "load-more" } as const,
              title: "Load more…",
              description: "Fetch the next Memory page",
              category: "Actions",
            },
          ]
        : []),
      {
        value: { type: "manage" } as const,
        title: "Manage Memory scopes",
        description: "Export or clear scoped Memory",
        category: "Actions",
      },
    ]
  })

  const record = (option: DialogSelectOption<MemoryDialogValue>) =>
    option.value.type === "record" ? option.value.item : undefined

  const isCurrent = (current: RouteSnapshot) => routeSnapshot()?.key === current.key

  const run = async (current: Routing, action: () => Promise<unknown>, reload = true) => {
    if (mutating()) return
    setMutating(true)
    try {
      await action()
      if (reload && isCurrent(current)) await load(current)
    } catch (error) {
      if (isCurrent(current))
        toast.show({ title: "Memory request failed", message: errorMessage(error), variant: "error" })
    } finally {
      setMutating(false)
    }
  }

  const replace = (current: Routing, item: MemoryInfo) => {
    if (!isCurrent(current)) return
    if (item.status === "rejected" || item.status === "deleted") {
      setStore("items", (items) => items.filter((value) => value.id !== item.id))
      return
    }
    setStore("items", (value) => value.id === item.id, reconcile(item))
  }

  const mutate = (item: MemoryInfo, operation: "accept" | "reject" | "pause" | "resume") => {
    const current = routing()
    if (!current) return
    void run(
      current,
      async () => {
        const result =
          operation === "accept" || operation === "reject"
            ? await memoryDecide(current.client, current.query, item, operation)
            : await memoryPause(current.client, current.query, item, operation === "pause")
        replace(current, result)
      },
      false,
    )
  }

  const reopen = () => dialog.replace(() => <DialogMemory />)

  const edit = async (item: MemoryInfo) => {
    const current = routing()
    if (!current) return
    const content = await DialogPrompt.show(dialog, "Memory content", {
      value: item.content,
      placeholder: "Memory content",
    })
    if (!isCurrent(current)) return
    if (content === null) return reopen()
    const kind = await selectMemoryKind(dialog, item.kind)
    if (!isCurrent(current)) return
    if (!kind) return reopen()
    const expiry = await DialogPrompt.show(dialog, "Memory expiry", {
      value: item.timeExpires ? new Date(item.timeExpires).toISOString() : "",
      placeholder: "ISO date/time or blank to clear",
    })
    if (!isCurrent(current)) return
    if (expiry === null) return reopen()
    try {
      await memoryUpdate(current.client, current.query, item, { content, kind, expiresAt: parseExpiry(expiry) })
      if (!isCurrent(current)) return
      toast.show({ message: "Memory updated", variant: "success" })
    } catch (error) {
      if (!isCurrent(current)) return
      toast.show({ title: "Memory update failed", message: errorMessage(error), variant: "error" })
    }
    reopen()
  }

  const remove = (item: MemoryInfo) => {
    if (toDelete() !== item.id) {
      setToDelete(item.id)
      toast.show({ message: "Trigger delete again to confirm", variant: "warning" })
      return
    }
    const current = routing()
    if (!current) return
    setToDelete(undefined)
    void run(
      current,
      async () => {
        await memoryRemove(current.client, current.query, item)
        if (isCurrent(current)) setStore("items", (items) => items.filter((value) => value.id !== item.id))
      },
      false,
    )
  }

  const exportRecords = async () => {
    const current = routing()
    if (!current) return
    try {
      const records = await current.client.memory
        .export({ ...current.query, includeGlobal: "true" })
        .then((result) => result.data)
      if (!records) throw new Error("Memory export response unavailable")
      if (!isCurrent(current)) return
      if (!clipboard.write) throw new Error("Clipboard is unavailable")
      await clipboard.write(JSON.stringify(records, null, 2))
      if (isCurrent(current)) toast.show({ message: "Memory JSON copied to clipboard", variant: "success" })
    } catch (error) {
      if (isCurrent(current))
        toast.show({ title: "Memory export failed", message: errorMessage(error), variant: "error" })
    }
  }

  const clear = () => {
    const current = routing()
    if (!current) return
    showClearTargets(dialog, current, toast, reopen, () => isCurrent(current))
  }

  const actions = createMemo(() => [
    {
      command: "dialog.memory.accept",
      title: "accept",
      disabled: (option: DialogSelectOption<MemoryDialogValue> | undefined) =>
        recordOption(option)?.status !== "proposed",
      onTrigger: (option: DialogSelectOption<MemoryDialogValue>) => mutate(record(option)!, "accept"),
    },
    {
      command: "dialog.memory.reject",
      title: "reject",
      disabled: (option: DialogSelectOption<MemoryDialogValue> | undefined) =>
        recordOption(option)?.status !== "proposed",
      onTrigger: (option: DialogSelectOption<MemoryDialogValue>) => mutate(record(option)!, "reject"),
    },
    {
      command: "dialog.memory.edit",
      title: "edit",
      disabled: (option: DialogSelectOption<MemoryDialogValue> | undefined) => !recordOption(option),
      onTrigger: (option: DialogSelectOption<MemoryDialogValue>) => void edit(record(option)!),
    },
    {
      command: "dialog.memory.pause",
      title: "pause/resume",
      disabled: (option: DialogSelectOption<MemoryDialogValue> | undefined) => {
        const status = recordOption(option)?.status
        return status !== "active" && status !== "paused"
      },
      onTrigger: (option: DialogSelectOption<MemoryDialogValue>) => {
        const item = record(option)!
        mutate(item, item.status === "active" ? "pause" : "resume")
      },
    },
    {
      command: "dialog.memory.delete",
      title: "delete",
      disabled: (option: DialogSelectOption<MemoryDialogValue> | undefined) => !recordOption(option),
      onTrigger: (option: DialogSelectOption<MemoryDialogValue>) => remove(record(option)!),
    },
    {
      command: "dialog.memory.export",
      title: "export",
      onTrigger: () => void exportRecords(),
    },
    {
      command: "dialog.memory.clear",
      title: "clear",
      onTrigger: clear,
    },
  ])

  return (
    <DialogSelect
      title="Memory Center"
      placeholder="Search Memory"
      options={options()}
      actions={actions()}
      locked={loading() || loadingMore() || mutating()}
      preserveSelection
      emptyView={<text>{loading() ? "Loading Memory…" : "No Memory records."}</text>}
      onSelect={(option) => {
        if (option.value.type === "load-more" && store.nextCursor) {
          const current = routing()
          if (current) void load(current, store.nextCursor)
        }
        if (option.value.type === "manage") clear()
      }}
    />
  )
}

function selectMemoryKind(dialog: DialogContext, current: MemoryInfo["kind"]) {
  return new Promise<MemoryInfo["kind"] | undefined>((resolve) => {
    dialog.replace(
      () => (
        <DialogSelect
          title="Memory kind"
          current={current}
          options={kinds.map((kind) => ({ value: kind, title: kind }))}
          onSelect={(option) => resolve(option.value)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

function recordOption(option: DialogSelectOption<MemoryDialogValue> | undefined) {
  return option?.value.type === "record" ? option.value.item : undefined
}

function showClearTargets(
  dialog: DialogContext,
  routing: Routing,
  toast: ToastContext,
  reopen: () => void,
  isCurrent: () => boolean,
) {
  let transitioning = false
  const targets = memoryClearTargets(routing.personal).map((value) => ({
    value,
    title: {
      workspace: "Clear workspace",
      relationship: "Reset relationship",
      user_global: "Clear global preferences",
    }[value],
    description: {
      workspace: "Delete current Workspace Memory",
      relationship: "Delete current Profile relationship Memory",
      user_global: "Delete user-global preferences",
    }[value],
  })) satisfies DialogSelectOption<"workspace" | "relationship" | "user_global">[]
  dialog.replace(
    () => (
      <DialogSelect
        title="Clear Memory"
        options={targets}
        onSelect={(option) => {
          transitioning = true
          void (async () => {
            const confirmed = await DialogConfirm.show(dialog, option.title, "This cannot be undone.", "cancel")
            if (!isCurrent()) return
            if (!confirmed) return reopen()
            let ownsDialog = true
            dialog.replace(
              () => <DialogPrompt title="Clearing Memory" busy busyText="Clearing…" />,
              () => {
                ownsDialog = false
              },
            )
            try {
              const cleared = await memoryClear(routing.client, routing.query, option.value)
              if (!isCurrent()) return
              toast.show({ message: `Cleared ${cleared.cleared} Memory records`, variant: "success" })
            } catch (error) {
              if (!isCurrent()) return
              toast.show({ title: "Memory clear failed", message: errorMessage(error), variant: "error" })
            }
            if (ownsDialog && isCurrent()) reopen()
          })()
        }}
      />
    ),
    () => {
      if (!transitioning) queueMicrotask(reopen)
    },
  )
}

import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
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
  type ContinuityRouteSnapshot,
} from "./dialog-continuity-grant-state"

type ListValue = { type: "grant"; item: ContinuityGrantInfo }
type DetailValue =
  | { type: "grant"; item: ContinuityGrantInfo }
  | { type: "audit"; item: ContinuityGrantAuditInfo }
  | { type: "back" }

type SourceGuard = {
  current: () => boolean
}

function useContinuitySource(source: ContinuityRouteSnapshot): SourceGuard {
  const route = useRoute()
  const sync = useSync()
  return {
    current() {
      const current = route.data
      if (current.type !== "session" || current.sessionID !== source.sessionID) return false
      const session = sync.session.get(current.sessionID)
      if (!session) return false
      return session.workspaceID === source.workspaceID && session.directory === source.directory
    },
  }
}

function watchContinuitySource(source: ContinuityRouteSnapshot, controller: AbortController) {
  const dialog = useDialog()
  const guard = useContinuitySource(source)
  createEffect(() => {
    if (guard.current()) return
    controller.abort()
    dialog.clear()
  })
  return guard
}

function DialogContinuityConfirm(props: {
  source: ContinuityRouteSnapshot
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const controller = new AbortController()
  watchContinuitySource(props.source, controller)
  onCleanup(() => controller.abort())
  return (
    <DialogConfirm
      title={props.title}
      message={props.message}
      label="cancel"
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  )
}

function confirmContinuity(
  dialog: ReturnType<typeof useDialog>,
  source: ContinuityRouteSnapshot,
  title: string,
  message: string,
) {
  return new Promise<boolean | undefined>((resolve) => {
    dialog.replace(
      () => (
        <DialogContinuityConfirm
          source={source}
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

export function DialogContinuityGrant(props: { source: ContinuityRouteSnapshot }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const controller = new AbortController()
  watchContinuitySource(props.source, controller)
  onCleanup(() => controller.abort())

  const [items, setItems] = createStore([] as ContinuityGrantInfo[])
  const [loading, setLoading] = createSignal(true)

  const load = async () => {
    setLoading(true)
    try {
      const value = await continuityGrantList(
        sdk.clientFor(props.source.workspaceID),
        props.source.query,
        controller.signal,
      )
      if (!controller.signal.aborted) setItems(reconcile(value, { key: "id" }))
    } catch (error) {
      if (!controller.signal.aborted)
        toast.show({ title: "Continuity request failed", message: errorMessage(error), variant: "error" })
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  onMount(() => {
    dialog.setSize("xlarge")
    void load()
  })

  const options = createMemo<DialogSelectOption<ListValue>[]>(() =>
    items.map((item) => ({
      value: { type: "grant", item },
      title: item.purpose,
      description: effectiveContinuityStatus(item),
      details: continuityGrantDetails(item),
      category: effectiveContinuityStatus(item),
      truncateTitle: true,
    })),
  )

  return (
    <DialogSelect
      title="Continuity Grants"
      placeholder="Search source-owned grants"
      options={options()}
      locked={loading()}
      emptyView={
        <text>{loading() ? "Loading Continuity grants…" : "No Continuity grants for this source session."}</text>
      }
      onSelect={(option) =>
        dialog.replace(() => <DialogContinuityGrantDetail source={props.source} grantID={option.value.item.id} />)
      }
    />
  )
}

function DialogContinuityGrantDetail(props: { source: ContinuityRouteSnapshot; grantID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const controller = new AbortController()
  const source = watchContinuitySource(props.source, controller)
  onCleanup(() => controller.abort())

  const [store, setStore] = createStore({
    item: undefined as ContinuityGrantInfo | undefined,
    audit: [] as ContinuityGrantAuditInfo[],
  })
  const [loading, setLoading] = createSignal(true)
  const client = sdk.clientFor(props.source.workspaceID)
  const reopenList = () => dialog.replace(() => <DialogContinuityGrant source={props.source} />)
  const reopenDetail = () =>
    dialog.replace(() => <DialogContinuityGrantDetail source={props.source} grantID={props.grantID} />)

  const load = async () => {
    setLoading(true)
    try {
      const [item, audit] = await Promise.all([
        continuityGrantGet(client, props.source.query, props.grantID, controller.signal),
        continuityGrantAudit(client, props.source.query, props.grantID, controller.signal),
      ])
      if (controller.signal.aborted) return
      setStore("item", reconcile(item))
      setStore("audit", reconcile(audit, { key: "id" }))
    } catch (error) {
      if (!controller.signal.aborted)
        toast.show({ title: "Continuity request failed", message: errorMessage(error), variant: "error" })
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  onMount(() => {
    dialog.setSize("xlarge")
    void load()
  })

  const options = createMemo<DialogSelectOption<DetailValue>[]>(() => {
    const item = store.item
    if (!item) return [{ value: { type: "back" }, title: "Back to grants", category: "Actions" }]
    return [
      {
        value: { type: "grant", item },
        title: item.purpose,
        description: effectiveContinuityStatus(item),
        details: [...continuityGrantDetails(item), `purpose: ${item.purpose}`],
        category: "Grant",
        truncateTitle: true,
      },
      ...store.audit.map((event) => ({
        value: { type: "audit", item: event } as const,
        title: `${event.action} · ${event.outcome}`,
        description: new Date(event.timeCreated).toISOString(),
        details: continuityAuditDetails([event]),
        category: "Content-free audit",
      })),
      { value: { type: "back" }, title: "Back to grants", category: "Actions" },
    ]
  })

  const selectedGrant = (option: DialogSelectOption<DetailValue> | undefined) =>
    option?.value.type === "grant" ? option.value.item : undefined

  const mutate = async (action: "approve" | "revoke", item: ContinuityGrantInfo) => {
    const confirmed = await confirmContinuity(
      dialog,
      props.source,
      action === "approve" ? "Approve continuity grant" : "Revoke continuity grant",
      action === "approve"
        ? "Approve this minimized handoff for the destination Companion session?"
        : "Revoke this continuity grant immediately?",
    )
    if (!confirmed) {
      if (source.current()) reopenDetail()
      return
    }
    try {
      if (action === "approve") await continuityGrantApprove(client, props.source.query, item.id)
      else await continuityGrantRevoke(client, props.source.query, item.id)
      if (source.current()) {
        toast.show({ message: `Continuity grant ${action === "approve" ? "approved" : "revoked"}`, variant: "success" })
      }
    } catch (error) {
      if (source.current()) {
        toast.show({ title: "Continuity request failed", message: errorMessage(error), variant: "error" })
      }
    } finally {
      if (source.current()) reopenDetail()
    }
  }

  const actions = createMemo(() => [
    {
      command: "dialog.continuity.approve",
      title: "approve",
      disabled: (option: DialogSelectOption<DetailValue> | undefined) => {
        const item = selectedGrant(option)
        return !item || effectiveContinuityStatus(item) !== "proposed"
      },
      onTrigger: (option: DialogSelectOption<DetailValue>) => void mutate("approve", selectedGrant(option)!),
    },
    {
      command: "dialog.continuity.revoke",
      title: "revoke",
      disabled: (option: DialogSelectOption<DetailValue> | undefined) => {
        const item = selectedGrant(option)
        const status = item && effectiveContinuityStatus(item)
        return !item || status === "revoked" || status === "expired"
      },
      onTrigger: (option: DialogSelectOption<DetailValue>) => void mutate("revoke", selectedGrant(option)!),
    },
  ])

  return (
    <DialogSelect
      title="Continuity Grant"
      placeholder="Review grant and content-free audit"
      options={options()}
      actions={actions()}
      locked={loading()}
      emptyView={<text>{loading() ? "Loading Continuity grant…" : "Continuity grant unavailable."}</text>}
      onSelect={(option) => {
        if (option.value.type === "back") reopenList()
      }}
    />
  )
}

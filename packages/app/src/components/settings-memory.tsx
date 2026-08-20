import type { MemoryAggregateGroup, MemoryHistoryInfo, MemoryInfo } from "@newhorse/sdk/v2"
import { Button } from "@newhorse/ui/button"
import { Icon } from "@newhorse/ui/icon"
import { Spinner } from "@newhorse/ui/spinner"
import { Select } from "@newhorse/ui/select"
import { TextField } from "@newhorse/ui/text-field"
import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { exportMemory } from "./settings-memory-export"
import { MemoryHistoryPanel } from "./settings-memory-history"
import { splitAggregateByScope, splitByScope } from "./settings-memory-scope"
import { useMemoryCenterState, type MemoryKind, type MemoryScope } from "./settings-memory-state"
import { useSettings } from "@/context/settings"
import { useConfirm } from "./confirm-dialog"

const kinds: MemoryKind[] = ["preference", "fact", "goal", "event", "relationship", "summary"]

export function memoryKindLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  value: MemoryKind,
) {
  return t(`settings.memory.kind.${value}`)
}

export function memoryScopeLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  value: MemoryScope,
) {
  return t(`settings.memory.scope.${value}`)
}

type Group = {
  key: string
  label: JSX.Element
  items: MemoryInfo[]
  defaultOpen: boolean
}

export function SettingsMemory(props: { sessionID?: string }) {
  const language = useLanguage()
  const memory = useMemoryCenterState(props.sessionID)
  const platform = usePlatform()
  const settings = useSettings()
  const confirm = useConfirm()
  const [editing, setEditing] = createSignal<string>()
  const [content, setContent] = createSignal("")
  const [kind, setKind] = createSignal<MemoryKind>("preference")
  const [expires, setExpires] = createSignal("")
  const [exporting, setExporting] = createSignal(false)
  const [auditID, setAuditID] = createSignal<string>()
  const [view, setView] = createSignal<"workspace" | "global">("workspace")
  const [search, setSearch] = createSignal("")
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})

  // Both tabs use the aggregate: the workspace tab lists other workspaces'
  // groups, the global tab lists the user_global group.
  const [aggregate, { refetch: refetchAggregate }] = createResource(
    () => (memory.aggregateReady() ? view() : undefined),
    () => memory.aggregate(),
  )

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.memory.title"),
      description: formatServerError(error, undefined, language.t("common.requestFailed")),
    })

  const startEdit = (item: MemoryInfo) => {
    setEditing(item.id)
    setContent(item.content)
    setKind(item.kind)
    setExpires(item.timeExpires ? localDateTime(item.timeExpires) : "")
  }

  const save = async (item: MemoryInfo): Promise<void> => {
    const value = expires()
    const time = value ? new Date(value).getTime() : null
    if (value && !Number.isFinite(time)) {
      fail(new Error(language.t("settings.memory.error.invalidExpiry")))
      return
    }
    await memory
      .update(item, { content: content(), kind: kind(), expiresAt: time })
      .then(() => {
        setEditing(undefined)
        void refetchAggregate()
      })
      .catch(fail)
  }

  const confirmClear = async (target: "workspace" | "relationship" | "user_global") => {
    const label =
      target === "user_global"
        ? language.t("settings.memory.scope.user_global")
        : target === "relationship"
          ? language.t("settings.memory.clear.relationship")
          : language.t("settings.memory.scope.workspace")
    const confirmed = await confirm({
      title: language.t("common.clear"),
      message: language.t("settings.memory.clear.confirm", { target: label }),
    })
    if (!confirmed) return
    void memory.clear(target).then(() => refetchAggregate()).catch(fail)
  }

  const confirmClearGroup = async (group: MemoryAggregateGroup) => {
    const label =
      group.scope === "user_global"
        ? language.t("settings.memory.scope.user_global")
        : (group.workspaceID ?? group.directory ?? language.t("settings.memory.scope.workspace"))
    const confirmed = await confirm({
      title: language.t("common.clear"),
      message: language.t("settings.memory.clear.confirm", { target: label }),
    })
    if (!confirmed) return
    await memory
      .clear(group.scope === "user_global" ? "user_global" : "workspace", group.workspaceID, group.directory)
      .then(() => refetchAggregate())
      .catch(fail)
  }

  // "Clear all workspaces" only touches workspace-scoped groups; the global
  // tab owns the user_global clear.
  const confirmClearAll = async () => {
    const groups = workspaceAggregateGroups()
    if (!groups || groups.length === 0) return
    const confirmed = await confirm({
      title: language.t("common.clear"),
      message: language.t("settings.memory.clear.confirm", {
        target: language.t("settings.memory.clear.all"),
      }),
    })
    if (!confirmed) return
    for (const group of groups) {
      try {
        await memory.clear("workspace", group.workspaceID, group.directory)
      } catch (error) {
        fail(error)
      }
    }
    void refetchAggregate()
    void memory.refresh().catch(fail)
  }

  const exportRecords = () => {
    setExporting(true)
    return memory
      .exportRecords()
      .then((records) => exportMemory(records, platform, downloadJson, new Date(), settings.general.downloadPath()))
      .finally(() => setExporting(false))
  }

  const loadHistory = (item: MemoryInfo) => memory.history(item)

  const matchesSearch = (item: MemoryInfo) => {
    const query = search().trim().toLowerCase()
    if (!query) return true
    return (
      item.content.toLowerCase().includes(query) ||
      item.kind.toLowerCase().includes(query) ||
      item.scope.toLowerCase().includes(query) ||
      (item.workspaceID ?? "").toLowerCase().includes(query)
    )
  }

  // The paginated list is scoped to the current workspace (+ user_global), so
  // its workspace slice identifies the current workspace inside the aggregate.
  // Derived from the records because the source routing may not carry a
  // workspaceID (implicit-local placement).
  const currentWorkspaceKey = createMemo(() => {
    const item = splitByScope(memory.state.items).workspace[0]
    if (!item) return undefined
    return item.workspaceID ?? item.directory
  })

  const workspaceAggregateGroups = createMemo(() => {
    const groups = aggregate()
    if (!groups) return undefined
    return splitAggregateByScope(groups).workspace
  })

  // "workspace" tab: the current workspace's own records from the paginated
  // list (keeps search + load-more working), rendered as one group.
  const currentGroup = createMemo<Group | undefined>(() => {
    const items = splitByScope(memory.state.items).workspace.filter(matchesSearch)
    if (items.length === 0) return undefined
    return {
      key: "__current__",
      label: language.t("settings.memory.group.current"),
      items,
      defaultOpen: true,
    }
  })

  // "workspace" tab: every other workspace's records from the aggregate,
  // excluding the current workspace so nothing is shown twice.
  const otherGroups = createMemo(() => {
    const groups = workspaceAggregateGroups()
    if (!groups) return undefined
    const currentKey = currentWorkspaceKey()
    return groups
      .filter((group) => (group.workspaceID ?? group.directory) !== currentKey)
      .map((group) => ({ ...group, items: group.items.filter(matchesSearch) }))
      .filter((group) => group.items.length > 0)
  })

  // "global" tab: all user_global records, from the aggregate (the paginated
  // list interleaves them with workspace records, so it is not a reliable
  // complete source).
  const globalGroups = createMemo(() => {
    const groups = aggregate()
    if (!groups) return undefined
    return splitAggregateByScope(groups)
      .global.map((group) => ({ ...group, items: group.items.filter(matchesSearch) }))
      .filter((group) => group.items.length > 0)
  })

  const cardProps = () => ({
    language,
    memory,
    editing,
    setEditing,
    content,
    setContent,
    kind,
    setKind,
    expires,
    setExpires,
    auditID,
    setAuditID,
    save,
    startEdit,
    fail,
    confirm,
    loadHistory,
  })

  const toggleGroup = (key: string) => {
    setCollapsed({ ...collapsed(), [key]: !collapsed()[key] })
  }

  return (
    <div class="flex min-h-0 min-w-0 flex-col px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--v2-background-bg-base)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-8 max-w-[720px]">
          <div>
            <h2 class="text-[16px] font-medium tracking-[-0.11px] text-v2-text-text-strong">
              {language.t("settings.memory.title")}
            </h2>
            <p class="text-[12px] text-text-weak">{language.t("settings.memory.description")}</p>
          </div>
          <Button
            size="small"
            variant="secondary"
            disabled={memory.loading() || exporting()}
            aria-busy={exporting()}
            onClick={() => void exportRecords().catch(fail)}
          >
            <Show when={exporting()}>
              <Spinner class="size-3.5 shrink-0" />
            </Show>
            {language.t("common.export")}
          </Button>
        </div>
      </div>

      <div class="flex max-w-[720px] flex-col gap-3 sm:flex-row sm:items-center">
        <div
          class="flex min-w-[260px] flex-1 items-center rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-0.5"
          role="radiogroup"
          aria-label={language.t("settings.memory.title")}
        >
          <button
            type="button"
            role="radio"
            aria-checked={view() === "workspace"}
            class={`flex-1 rounded-md px-3 py-1 text-[13px] transition-colors ${
              view() === "workspace"
                ? "bg-v2-background-bg-layer-03 font-medium text-v2-text-text-base shadow-[var(--v2-elevation-raised)]"
                : "text-v2-text-text-weak hover:text-v2-text-text-base"
            }`}
            onClick={() => setView("workspace")}
          >
            {language.t("settings.memory.view.workspace")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view() === "global"}
            class={`flex-1 rounded-md px-3 py-1 text-[13px] transition-colors ${
              view() === "global"
                ? "bg-v2-background-bg-layer-03 font-medium text-v2-text-text-base shadow-[var(--v2-elevation-raised)]"
                : "text-v2-text-text-weak hover:text-v2-text-text-base"
            }`}
            onClick={() => setView("global")}
          >
            {language.t("settings.memory.view.global")}
          </button>
        </div>
        <Show when={view() === "workspace"}>
          <Button
            size="small"
            variant="secondary"
            class="shrink-0"
            disabled={!workspaceAggregateGroups() || workspaceAggregateGroups()!.length === 0}
            onClick={() => void confirmClearAll()}
          >
            {language.t("settings.memory.clear.all")}
          </Button>
        </Show>
        <TextField
          value={search()}
          onChange={setSearch}
          placeholder={language.t("settings.memory.search.placeholder")}
          aria-label={language.t("settings.memory.search.placeholder")}
          class="w-full shrink-0 sm:w-56"
        />
      </div>

      <div class="mt-4 flex flex-col gap-4 max-w-[720px]">
        <Show when={view() === "workspace"}>
          <Show
            when={!memory.loading()}
            fallback={
              <div role="status" aria-live="polite" data-state="loading" class="text-v2-text-text-faint">
                {language.t("settings.memory.loading")}
              </div>
            }
          >
            <Show
              when={!memory.ready.error}
              fallback={
                <div class="flex items-center gap-3 text-v2-text-text-weak">
                  <span>{language.t("common.requestFailed")}</span>
                  <Button size="small" onClick={() => void memory.refresh().catch(fail)}>
                    {language.t("common.retry")}
                  </Button>
                </div>
              }
            >
              <Show
                when={currentGroup() || (otherGroups()?.length ?? 0) > 0}
                fallback={
                  <div role="status" aria-live="polite" data-state="empty" class="text-v2-text-text-weak">
                    {search().trim() && memory.state.items.length > 0
                      ? language.t("settings.memory.search.empty")
                      : language.t("settings.memory.empty")}
                  </div>
                }
              >
                <Show when={currentGroup()}>
                  {(group) => (
                      <GroupSection
                        groupKey={group().key}
                        label={group().label}
                        scope="workspace"
                        items={group().items}
                      isOpen={() => !collapsed()[group().key]}
                      onToggle={() => toggleGroup(group().key)}
                      onClear={() => void confirmClear("workspace")}
                      cardProps={cardProps()}
                    />
                  )}
                </Show>
                <For each={otherGroups() ?? []}>
                  {(group, gi) => {
                    const groupKey = `ws:${group.workspaceID ?? group.directory ?? gi()}`
                    const label = group.workspaceID || group.directory
                      ? language.t("settings.memory.group.workspace", {
                          id: (group.workspaceID ?? group.directory) ?? "",
                        })
                      : language.t("settings.memory.all.workspace")
                    return (
                      <GroupSection
                        groupKey={group.workspaceID ?? group.directory ?? "other"}
                        label={label}
                        scope="workspace"
                        items={group.items}
                        isOpen={() => !collapsed()[groupKey]}
                        onToggle={() => toggleGroup(groupKey)}
                        onClear={() => void confirmClearGroup(group)}
                        cardProps={{ ...cardProps(), onMutated: () => void refetchAggregate() }}
                      />
                    )
                  }}
                </For>
                <Show when={memory.state.nextCursor}>
                  <Button disabled={memory.state.loadingMore} onClick={() => void memory.loadMore().catch(fail)}>
                    {language.t("common.loadMore")}
                  </Button>
                </Show>
                <Show when={splitByScope(memory.state.items).workspace.length > 0}>
                  <div class="flex flex-wrap gap-2 border-t border-v2-border-border-muted pt-4">
                    <Button size="small" onClick={() => confirmClear("workspace")}>
                      {language.t("settings.memory.clear.workspace")}
                    </Button>
                    <Show when={memory.contentScope() === "personal"}>
                      <Button size="small" onClick={() => confirmClear("relationship")}>
                        {language.t("settings.memory.clear.relationship")}
                      </Button>
                    </Show>
                    <Button size="small" onClick={() => confirmClear("user_global")}>
                      {language.t("settings.memory.clear.global")}
                    </Button>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
        <Show when={view() === "global"}>
          <Show
            when={!aggregate.loading}
            fallback={
              <div role="status" aria-live="polite" data-state="loading" class="text-v2-text-text-faint">
                {language.t("settings.memory.loading")}
              </div>
            }
          >
            <Show
              when={!aggregate.error}
              fallback={
                <div class="flex items-center gap-3 text-v2-text-text-weak">
                  <span>{language.t("common.requestFailed")}</span>
                  <Button size="small" onClick={() => void refetchAggregate()}>
                    {language.t("common.retry")}
                  </Button>
                </div>
              }
            >
              <Show
                when={(globalGroups()?.length ?? 0) > 0}
                fallback={
                  <div role="status" aria-live="polite" data-state="empty" class="text-v2-text-text-weak">
                    {search().trim() && (aggregate()?.length ?? 0) > 0
                      ? language.t("settings.memory.search.empty")
                      : language.t("settings.memory.empty")}
                  </div>
                }
              >
                <For each={globalGroups() ?? []}>
                  {(group) => {
                    const groupKey = "global"
                    return (
                      <GroupSection
                        groupKey={groupKey}
                        label={language.t("settings.memory.group.global")}
                        scope="global"
                        items={group.items}
                        isOpen={() => !collapsed()[groupKey]}
                        onToggle={() => toggleGroup(groupKey)}
                        onClear={() => void confirmClear("user_global")}
                        cardProps={{ ...cardProps(), onMutated: () => void refetchAggregate() }}
                      />
                    )
                  }}
                </For>
                <Show when={(globalGroups()?.length ?? 0) > 0}>
                  <div class="flex flex-wrap gap-2 border-t border-v2-border-border-muted pt-4">
                    <Button size="small" onClick={() => confirmClear("user_global")}>
                      {language.t("settings.memory.clear.global")}
                    </Button>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function GroupSection(props: {
  groupKey: string
  label: JSX.Element
  scope: "workspace" | "global"
  items: MemoryInfo[]
  isOpen: () => boolean
  onToggle: () => void
  onClear: () => void
  cardProps: MemoryCardActions
}) {
  const language = useLanguage()
  return (
    <section
      class="flex flex-col gap-3 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3 transition-colors"
      data-memory-group={props.groupKey}
    >
      <div class="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover"
          aria-expanded={props.isOpen()}
          aria-label={language.t("settings.memory.group.toggle")}
          onClick={props.onToggle}
        >
          <Icon
            name={props.isOpen() ? "chevron-down" : "chevron-right"}
            class="size-3.5 shrink-0 text-v2-text-text-faint"
          />
          <span class="truncate text-[13px] font-medium text-v2-text-text-base">{props.label}</span>
          <span class="ml-1 shrink-0 text-[11px] text-v2-text-text-weaker">
            {props.items.length} {language.t("settings.memory.all.count")}
          </span>
        </button>
        <Button size="small" variant="secondary" class="shrink-0" onClick={props.onClear}>
          {language.t("settings.memory.clear.short")}
        </Button>
      </div>
      <Show when={props.isOpen()}>
        <div class="flex flex-col gap-3">
          <For each={props.items}>
            {(item) => <MemoryCard item={item} scope={props.scope} {...props.cardProps} />}
          </For>
        </div>
      </Show>
    </section>
  )
}

type MemoryCardActions = {
  language?: ReturnType<typeof useLanguage>
  memory?: ReturnType<typeof useMemoryCenterState>
  editing?: () => string | undefined
  setEditing?: (id: string | undefined) => void
  content?: () => string
  setContent?: (value: string) => void
  kind?: () => MemoryKind
  setKind?: (value: MemoryKind) => void
  expires?: () => string
  setExpires?: (value: string) => void
  auditID?: () => string | undefined
  setAuditID?: (id: string | undefined) => void
  save?: (item: MemoryInfo) => Promise<void>
  startEdit?: (item: MemoryInfo) => void
  fail?: (error: unknown) => void
  confirm?: ReturnType<typeof useConfirm>
  loadHistory?: (item: MemoryInfo) => Promise<MemoryHistoryInfo[]>
  onMutated?: () => void
}

type MemoryCardProps = MemoryCardActions & { item: MemoryInfo; scope?: "workspace" | "global" }

function MemoryCard(props: MemoryCardProps) {
  const language = () => props.language ?? useLanguage()
  const t = (key: string, params?: Record<string, string | number | boolean>) =>
    language().t(key, params)
  const item = () => props.item
  const editable = () => Boolean(props.editing && props.setEditing && props.startEdit)
  const auditOpen = () => props.auditID?.() === item().id

  return (
    <article
      class="flex flex-col gap-3 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-base p-4 transition-colors hover:border-v2-border-border-active hover:bg-v2-background-bg-layer-01"
      data-memory-id={item().id}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-[11px] text-v2-text-text-weaker">
          {props.scope === "global"
            ? t("settings.memory.view.global")
            : props.scope === "workspace"
              ? t("settings.memory.view.workspace")
              : memoryScopeLabel(t, item().scope)} · {source(item(), t)}
        </span>
        <span class="text-[11px] text-v2-text-text-weaker">{item().status}</span>
      </div>

      <Show
        when={editable() && props.editing?.() === item().id}
        fallback={<p class="whitespace-pre-wrap text-[14px] leading-6 text-v2-text-text-base">{item().content}</p>}
      >
        <div class="flex flex-col gap-2">
          <TextField
            multiline
            value={props.content?.() ?? ""}
            onChange={(value) => props.setContent?.(value)}
            aria-label={t("settings.memory.content")}
          />
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Select
              options={kinds}
              current={props.kind?.() ?? "preference"}
              label={(value) => memoryKindLabel(t, value)}
              onSelect={(value) => value && props.setKind?.(value as MemoryKind)}
              variant="secondary"
              size="small"
              triggerProps={{ "aria-label": t("settings.memory.kind") }}
            />
            <TextField
              type="datetime-local"
              value={props.expires?.() ?? ""}
              onChange={(value) => props.setExpires?.(value)}
              aria-label={t("settings.memory.expiry")}
            />
          </div>
        </div>
      </Show>

      <Show when={editable()}>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={props.memory?.state.mutating === item().id}>
            <Spinner class="size-3.5 shrink-0 text-v2-text-text-weak" />
          </Show>
          <Show
            when={props.editing?.() === item().id}
            fallback={
              <Button size="small" disabled={!!props.memory?.state.mutating} onClick={() => props.startEdit?.(item())}>
                {t("common.edit")}
              </Button>
            }
          >
            <Button size="small" disabled={!!props.memory?.state.mutating} onClick={() => void props.save?.(item())}>
              {t("common.save")}
            </Button>
            <Button size="small" onClick={() => props.setEditing?.(undefined)}>
              {t("common.cancel")}
            </Button>
          </Show>
          <Show when={item().status === "active" || item().status === "paused"}>
            <Button
              size="small"
              disabled={!!props.memory?.state.mutating}
              onClick={() =>
                void props.memory
                  ?.pause(item(), item().status === "active")
                  .then(() => props.onMutated?.())
                  .catch(props.fail ?? (() => {}))
              }
            >
              {item().status === "active" ? t("common.pause") : t("common.resume")}
            </Button>
          </Show>
          <Button
            size="small"
            disabled={!!props.memory?.state.mutating}
            onClick={() => {
              void (async () => {
                const confirmed = await props.confirm?.({
                  title: t("common.delete"),
                  message: t("settings.memory.delete.confirm"),
                })
                if (!confirmed) return
                void props.memory
                  ?.remove(item())
                  .then(() => props.onMutated?.())
                  .catch(props.fail ?? (() => {}))
              })()
            }}
          >
            {t("common.delete")}
          </Button>
          <Button
            size="small"
            aria-expanded={auditOpen()}
            onClick={() => props.setAuditID?.(auditOpen() ? undefined : item().id)}
          >
            {auditOpen() ? t("settings.memory.audit.hide") : t("settings.memory.audit.view")}
          </Button>
        </div>
        <Show when={auditOpen()}>
          <MemoryHistoryPanel item={item()} load={props.loadHistory ?? (() => Promise.resolve([]))} />
        </Show>
      </Show>
    </article>
  )
}

function downloadJson(input: { filename: string; contents: string }) {
  const blob = new Blob([input.contents], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = input.filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function source(item: MemoryInfo, t: (key: string, params?: Record<string, string | number | boolean>) => string) {
  if (item.sourceMessageID) return t("settings.memory.source.message", { id: item.sourceMessageID })
  if (item.sourceSessionID) return t("settings.memory.source.session", { id: item.sourceSessionID })
  return t("settings.memory.source.direct")
}

function localDateTime(value: number) {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

function shortWorkspace(id: string) {
  if (id.length <= 12) return id
  return id.slice(0, 6) + "…" + id.slice(-4)
}

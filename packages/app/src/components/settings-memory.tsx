import type { MemoryHistoryInfo, MemoryInfo } from "@newhorse/sdk/v2"
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
import { useMemoryCenterState, type MemoryKind, type MemoryScope, type MemoryStatus } from "./settings-memory-state"
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

export function memoryStatusLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  value: MemoryStatus,
) {
  return t(`settings.memory.status.${value}`)
}

export function memoryProvenanceLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  value: MemoryInfo["provenance"],
) {
  return t(`settings.memory.provenance.${value}`)
}

// Category-toned tag pills: each facet (kind/status/scope/provenance) gets its
// own weak color so a memory's metadata reads as grouped at a glance.
function memoryKindTag(memoryKind: MemoryKind): string {
  switch (memoryKind) {
    case "relationship":
    case "summary":
      return "border-v2-border-border-muted bg-v2-background-bg-layer-03 text-v2-text-text-accent"
    default:
      return "border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-text-text-muted"
  }
}

function memoryStatusTag(status: MemoryStatus): string {
  switch (status) {
    case "active":
      return "border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-text-text-accent"
    case "paused":
      return "border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-text-text-muted"
    default:
      return "border-v2-border-border-muted bg-v2-background-bg-layer-01 text-v2-text-text-faint"
  }
}

function memoryScopeTag(scope: MemoryScope): string {
  return scope === "user_global"
    ? "border-v2-border-border-muted bg-v2-background-bg-layer-02 text-v2-text-text-accent"
    : "border-v2-border-border-muted bg-v2-background-bg-layer-01 text-v2-text-text-faint"
}

function memoryProvenanceTag(): string {
  return "border-v2-border-border-muted bg-transparent text-v2-text-text-weaker"
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
  const [view, setView] = createSignal<"current" | "all">("current")
  const [search, setSearch] = createSignal("")
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})

  const [aggregate] = createResource(
    () => (view() === "all" ? view() : undefined),
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
      .then(() => setEditing(undefined))
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
    void memory.clear(target).catch(fail)
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

  // "current" view: split items by workspace so each workspace has a
  // collapsible header. Items without a workspaceID fall under the current
  // workspace group; user_global items are split into a global bucket.
  // "current" view: only the current workspace's own memories, plus the
  // user_global bucket (shown last so it never reads as part of the workspace).
  // Memories from other workspaces are hidden here — use "all" to see them.
  const currentGroups = createMemo<Group[]>(() => {
    const items = memory.state.items.filter(matchesSearch)
    if (items.length === 0) return []
    const buckets = new Map<string, MemoryInfo[]>()
    for (const item of items) {
      if (item.scope === "user_global") {
        const list = buckets.get("__global__") ?? []
        list.push(item)
        buckets.set("__global__", list)
        continue
      }
      // Workspace scoped: only the current workspace's workspaceID (or the
      // current directory for legacy rows). Anything else is a different
      // workspace's memory and belongs in the "all" view.
      // Legacy rows without a workspaceID bucket under the current workspace.
      if (item.workspaceID) {
        const currentID = memory.currentWorkspaceID()
        if (currentID && item.workspaceID !== currentID) continue
      }
      const list = buckets.get("__current__") ?? []
      list.push(item)
      buckets.set("__current__", list)
    }
    const out: Group[] = []
    for (const [key, list] of buckets) {
      out.push({
        key,
        label:
          key === "__global__"
            ? language.t("settings.memory.group.global")
            : language.t("settings.memory.group.current"),
        items: list,
        defaultOpen: true,
      })
    }
    // Stable order: current workspace first, then global.
    out.sort((a, b) => {
      if (a.key === "__current__") return -1
      if (b.key === "__global__") return 1
      return a.key.localeCompare(b.key)
    })
    return out
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
            aria-checked={view() === "current"}
            class={`flex-1 rounded-md px-3 py-1 text-[13px] transition-colors ${
              view() === "current"
                ? "bg-v2-background-bg-layer-03 font-medium text-v2-text-text-base shadow-[var(--v2-elevation-raised)]"
                : "text-v2-text-text-weak hover:text-v2-text-text-base"
            }`}
            onClick={() => setView("current")}
          >
            {language.t("settings.memory.view.current")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view() === "all"}
            class={`flex-1 rounded-md px-3 py-1 text-[13px] transition-colors ${
              view() === "all"
                ? "bg-v2-background-bg-layer-03 font-medium text-v2-text-text-base shadow-[var(--v2-elevation-raised)]"
                : "text-v2-text-text-weak hover:text-v2-text-text-base"
            }`}
            onClick={() => setView("all")}
          >
            {language.t("settings.memory.view.all")}
          </button>
        </div>
        <Show when={view() === "current"}>
          <TextField
            value={search()}
            onChange={setSearch}
            placeholder={language.t("settings.memory.search.placeholder")}
            aria-label={language.t("settings.memory.search.placeholder")}
            class="w-full shrink-0 sm:w-56"
          />
        </Show>
      </div>

      <div class="mt-4 flex flex-col gap-4 max-w-[720px]">
        <Show when={view() === "all"}>
          <Show
            when={!aggregate.loading}
            fallback={
              <div role="status" aria-live="polite" data-state="loading" class="text-v2-text-text-faint">
                {language.t("settings.memory.loading")}
              </div>
            }
          >
            <Show
              when={(aggregate()?.length ?? 0) > 0}
              fallback={
                <div role="status" aria-live="polite" data-state="empty" class="text-v2-text-text-weak">
                  {language.t("settings.memory.all.empty")}
                </div>
              }
            >
              <For each={aggregate()}>
                {(group, gi) => {
                  const groupKey = group.scope === "user_global" ? `all-global` : `all-${group.workspaceID ?? group.directory ?? gi()}`
                  const isOpen = () => !collapsed()[groupKey]
                  return (
                    <section
                      class="flex flex-col gap-3 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3 transition-colors"
                      data-memory-group={group.workspaceID ?? group.directory ?? "global"}
                    >
                      <div class="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1">
                        <button
                          type="button"
                          class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                          aria-expanded={isOpen()}
                          aria-label={language.t("settings.memory.group.toggle")}
                          onClick={() => toggleGroup(groupKey)}
                        >
                          <Icon
                            name={isOpen() ? "chevron-down" : "chevron-right"}
                            class="size-3.5 shrink-0 text-v2-text-text-faint"
                          />
                          <span class="truncate text-[13px] font-medium text-v2-text-text-base">
                            {group.scope === "user_global"
                              ? language.t("settings.memory.all.global")
                              : (group.workspaceID ?? group.directory ?? language.t("settings.memory.all.workspace"))}
                          </span>
                          <span class="ml-1 shrink-0 text-[11px] text-v2-text-text-weaker">
                            {group.items.length} {language.t("settings.memory.all.count")}
                          </span>
                        </button>
                        <Button
                          size="small"
                          variant="secondary"
                          class="shrink-0"
                          onClick={() => confirmClear(group.scope === "user_global" ? "user_global" : "workspace")}
                        >
                          {language.t("settings.memory.clear.short")}
                        </Button>
                      </div>
                      <Show when={isOpen()}>
                        <div class="flex flex-col gap-3">
                          <For each={group.items}>{(item) => <MemoryCard item={item} />}</For>
                        </div>
                      </Show>
                    </section>
                  )
                }}
              </For>
            </Show>
          </Show>
        </Show>
        <Show when={view() === "current"}>
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
                when={currentGroups().length > 0}
                fallback={
                  <div role="status" aria-live="polite" data-state="empty" class="text-v2-text-text-weak">
                    {search().trim() && memory.state.items.length > 0
                      ? language.t("settings.memory.search.empty")
                      : language.t("settings.memory.empty")}
                  </div>
                }
              >
                <For each={currentGroups()}>
                  {(group) => {
                    const isOpen = () => !collapsed()[group.key]
                    return (
                      <section
                        class="flex flex-col gap-3 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3 transition-colors"
                        data-memory-group={group.key}
                      >
                        <div class="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1">
                          <button
                            type="button"
                            class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                            aria-expanded={isOpen()}
                            aria-label={language.t("settings.memory.group.toggle")}
                            onClick={() => toggleGroup(group.key)}
                          >
                            <Icon
                              name={isOpen() ? "chevron-down" : "chevron-right"}
                              class="size-3.5 shrink-0 text-v2-text-text-faint"
                            />
                            <span class="truncate text-[13px] font-medium text-v2-text-text-base">{group.label}</span>
                            <span class="ml-1 shrink-0 text-[11px] text-v2-text-text-weaker">
                              {group.items.length} {language.t("settings.memory.all.count")}
                            </span>
                          </button>
                          <Button
                            size="small"
                            variant="secondary"
                            class="shrink-0"
                            onClick={() =>
                              confirmClear(group.key === "__global__" ? "user_global" : "workspace")
                            }
                          >
                            {language.t("settings.memory.clear.short")}
                          </Button>
                        </div>
                        <Show when={isOpen()}>
                          <div class="flex flex-col gap-3">
                            <For each={group.items}>
                              {(item) => (
                                <MemoryCard
                                  item={item}
                                  language={language}
                                  memory={memory}
                                  editing={editing}
                                  setEditing={setEditing}
                                  content={content}
                                  setContent={setContent}
                                  kind={kind}
                                  setKind={setKind}
                                  expires={expires}
                                  setExpires={setExpires}
                                  auditID={auditID}
                                  setAuditID={setAuditID}
                                  save={save}
                                  startEdit={startEdit}
                                  fail={fail}
                                  confirm={confirm}
                                  loadHistory={loadHistory}
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                      </section>
                    )
                  }}
                </For>
              </Show>

              <Show when={memory.state.nextCursor}>
                <Button disabled={memory.state.loadingMore} onClick={() => void memory.loadMore().catch(fail)}>
                  {language.t("common.loadMore")}
                </Button>
              </Show>

              <Show when={memory.state.items.length > 0}>
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
      </div>
    </div>
  )
}

function MemoryCard(props: {
  item: MemoryInfo
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
}) {
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
        <div class="flex flex-wrap gap-1.5 text-[11px]">
          <span class={`rounded-[4px] border px-1.5 py-0.5 ${memoryKindTag(item().kind)}`}>
            {memoryKindLabel(t, item().kind)}
          </span>
          <span class={`rounded-[4px] border px-1.5 py-0.5 ${memoryStatusTag(item().status)}`}>
            {memoryStatusLabel(t, item().status)}
          </span>
          <span class={`rounded-[4px] border px-1.5 py-0.5 ${memoryScopeTag(item().scope)}`}>
            {memoryScopeLabel(t, item().scope)}
          </span>
          <span class={`rounded-[4px] border px-1.5 py-0.5 ${memoryProvenanceTag()}`}>
            {memoryProvenanceLabel(t, item().provenance)}
          </span>
        </div>
        <span class="text-[11px] text-v2-text-text-weaker">{source(item(), t)}</span>
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
                void props.memory?.remove(item()).catch(props.fail ?? (() => {}))
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

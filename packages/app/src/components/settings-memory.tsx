import type { MemoryInfo } from "@newhorse/sdk/v2"
import { Button } from "@newhorse/ui/button"
import { Spinner } from "@newhorse/ui/spinner"
import { Select } from "@newhorse/ui/select"
import { TextField } from "@newhorse/ui/text-field"
import { For, Show, createSignal } from "solid-js"
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

  const save = async (item: MemoryInfo) => {
    const value = expires()
    const time = value ? new Date(value).getTime() : null
    if (value && !Number.isFinite(time)) return fail(new Error(language.t("settings.memory.error.invalidExpiry")))
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

  return (
    <div class="flex min-h-0 min-w-0 flex-col px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-8 max-w-[720px]">
          <div>
            <h2 class="text-16-medium text-text-strong">{language.t("settings.memory.title")}</h2>
            <p class="text-12-regular text-text-weak">{language.t("settings.memory.description")}</p>
          </div>
          <Button
            size="small"
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

      <div class="flex flex-col gap-4 max-w-[720px]">
        <Show
          when={!memory.loading()}
          fallback={
            <div role="status" aria-live="polite" data-state="loading">
              {language.t("settings.memory.loading")}
            </div>
          }
        >
          <Show
            when={!memory.ready.error}
            fallback={
              <div class="flex items-center gap-3 text-14-regular text-text-weak">
                <span>{language.t("common.requestFailed")}</span>
                <Button size="small" onClick={() => void memory.refresh().catch(fail)}>
                  {language.t("common.retry")}
                </Button>
              </div>
            }
          >
            <Show
              when={memory.state.items.length > 0}
              fallback={
                <div role="status" aria-live="polite" data-state="empty" class="text-14-regular text-text-weak">
                  {language.t("settings.memory.empty")}
                </div>
              }
            >
            <For each={memory.state.items}>
              {(item) => (
                <article class="flex flex-col gap-3 rounded-lg bg-surface-base p-4" data-memory-id={item.id}>
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex flex-wrap gap-2 text-11-regular text-text-weak">
                      <span>{memoryKindLabel(language.t, item.kind)}</span>
                      <span>{memoryStatusLabel(language.t, item.status)}</span>
                      <span>{memoryScopeLabel(language.t, item.scope)}</span>
                      <span>{memoryProvenanceLabel(language.t, item.provenance)}</span>
                    </div>
                    <span class="text-11-regular text-text-weaker">{source(item, language.t)}</span>
                  </div>

                  <Show
                    when={editing() === item.id}
                    fallback={<p class="whitespace-pre-wrap text-14-regular text-text-base">{item.content}</p>}
                  >
                    <div class="flex flex-col gap-2">
                      <TextField multiline value={content()} onChange={setContent} aria-label={language.t("settings.memory.content")} />
                      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Select
                          options={kinds}
                          current={kind()}
                          label={(value) => memoryKindLabel(language.t, value)}
                          onSelect={(value) => value && setKind(value)}
                          variant="secondary"
                          size="small"
                          triggerProps={{ "aria-label": language.t("settings.memory.kind") }}
                        />
                        <TextField
                          type="datetime-local"
                          value={expires()}
                          onChange={setExpires}
                          aria-label={language.t("settings.memory.expiry")}
                        />
                      </div>
                    </div>
                  </Show>

                  <div class="flex flex-wrap items-center gap-2">
                    <Show when={memory.state.mutating === item.id}>
                      <Spinner class="size-3.5 shrink-0 text-text-weak" />
                    </Show>
                    <Show
                      when={editing() === item.id}
                      fallback={
                        <Button size="small" disabled={!!memory.state.mutating} onClick={() => startEdit(item)}>
                          {language.t("common.edit")}
                        </Button>
                      }
                    >
                      <Button size="small" disabled={!!memory.state.mutating} onClick={() => void save(item)}>
                        {language.t("common.save")}
                      </Button>
                      <Button size="small" onClick={() => setEditing(undefined)}>
                        {language.t("common.cancel")}
                      </Button>
                    </Show>
                    <Show when={item.status === "active" || item.status === "paused"}>
                      <Button
                        size="small"
                        disabled={!!memory.state.mutating}
                        onClick={() => void memory.pause(item, item.status === "active").catch(fail)}
                      >
                        {item.status === "active" ? language.t("common.pause") : language.t("common.resume")}
                      </Button>
                    </Show>
                    <Button
                      size="small"
                      disabled={!!memory.state.mutating}
                      onClick={() => {
                        void (async () => {
                          const confirmed = await confirm({
                            title: language.t("common.delete"),
                            message: language.t("settings.memory.delete.confirm"),
                          })
                          if (!confirmed) return
                          void memory.remove(item).catch(fail)
                        })()
                      }}
                    >
                      {language.t("common.delete")}
                    </Button>
                    <Button
                      size="small"
                      aria-expanded={auditID() === item.id}
                      onClick={() => setAuditID(auditID() === item.id ? undefined : item.id)}
                    >
                      {auditID() === item.id
                        ? language.t("settings.memory.audit.hide")
                        : language.t("settings.memory.audit.view")}
                    </Button>
                  </div>
                  <Show when={auditID() === item.id}>
                    <MemoryHistoryPanel item={item} load={loadHistory} />
                  </Show>
                </article>
              )}
            </For>
            </Show>
            </Show>

          <Show when={memory.state.nextCursor}>
            <Button disabled={memory.state.loadingMore} onClick={() => void memory.loadMore().catch(fail)}>
              {language.t("common.loadMore")}
            </Button>
          </Show>

          <Show when={memory.state.items.length > 0}>
            <div class="flex flex-wrap gap-2 border-t border-border-weak-base pt-4">
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
      </div>
    </div>
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

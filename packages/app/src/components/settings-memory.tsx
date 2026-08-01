import type { MemoryInfo } from "@newhorse/sdk/v2"
import { Button } from "@newhorse/ui/button"
import { Select } from "@newhorse/ui/select"
import { TextField } from "@newhorse/ui/text-field"
import { For, Show, createSignal } from "solid-js"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import { usePlatform } from "@/context/platform"
import { exportMemory } from "./settings-memory-export"
import { useMemoryCenterState, type MemoryKind } from "./settings-memory-state"

const kinds: MemoryKind[] = ["preference", "fact", "goal", "event", "relationship", "summary"]

export function SettingsMemory(props: { sessionID?: string }) {
  const memory = useMemoryCenterState(props.sessionID)
  const platform = usePlatform()
  const [editing, setEditing] = createSignal<string>()
  const [content, setContent] = createSignal("")
  const [kind, setKind] = createSignal<MemoryKind>("preference")
  const [expires, setExpires] = createSignal("")

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: "Memory request failed",
      description: formatServerError(error, undefined, "Unknown Memory error"),
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
    if (value && !Number.isFinite(time)) return fail(new Error("Expiry must be a valid date and time"))
    await memory
      .update(item, { content: content(), kind: kind(), expiresAt: time })
      .then(() => setEditing(undefined))
      .catch(fail)
  }

  const confirmClear = (target: "workspace" | "relationship" | "user_global") => {
    if (!window.confirm(`Clear ${target.replace("_", "-")} memory? This cannot be undone.`)) return
    void memory.clear(target).catch(fail)
  }

  const exportRecords = async () => {
    const records = await memory.exportRecords()
    await exportMemory(records, platform, downloadJson)
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-8 max-w-[720px]">
          <div>
            <h2 class="text-16-medium text-text-strong">Memory Center</h2>
            <p class="text-12-regular text-text-weak">Review and manage Memory in the current content scope.</p>
          </div>
          <Button size="small" disabled={memory.loading()} onClick={() => void exportRecords().catch(fail)}>
            Export
          </Button>
        </div>
      </div>

      <div class="flex flex-col gap-4 max-w-[720px]">
        <Show when={!memory.loading()} fallback={<div>Loading Memory…</div>}>
          <Show
            when={memory.state.items.length > 0}
            fallback={<div class="text-14-regular text-text-weak">No Memory records.</div>}
          >
            <For each={memory.state.items}>
              {(item) => (
                <article class="flex flex-col gap-3 rounded-lg bg-surface-base p-4" data-memory-id={item.id}>
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex flex-wrap gap-2 text-11-regular text-text-weak">
                      <span>{item.kind}</span>
                      <span>{item.status}</span>
                      <span>{item.scope.replace("_", "-")}</span>
                      <span>{item.provenance.replace("_", " ")}</span>
                    </div>
                    <span class="text-11-regular text-text-weaker">{source(item)}</span>
                  </div>

                  <Show
                    when={editing() === item.id}
                    fallback={<p class="whitespace-pre-wrap text-14-regular text-text-base">{item.content}</p>}
                  >
                    <div class="flex flex-col gap-2">
                      <TextField multiline value={content()} onChange={setContent} aria-label="Memory content" />
                      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Select
                          options={kinds}
                          current={kind()}
                          label={(value) => value}
                          onSelect={(value) => value && setKind(value)}
                          variant="secondary"
                          size="small"
                          triggerProps={{ "aria-label": "Memory kind" }}
                        />
                        <TextField
                          type="datetime-local"
                          value={expires()}
                          onChange={setExpires}
                          aria-label="Memory expiry"
                        />
                      </div>
                    </div>
                  </Show>

                  <div class="flex flex-wrap gap-2">
                    <Show when={item.status === "proposed"}>
                      <Button
                        size="small"
                        disabled={!!memory.state.mutating}
                        onClick={() => void memory.decide(item, "accept").catch(fail)}
                      >
                        Accept
                      </Button>
                      <Button
                        size="small"
                        disabled={!!memory.state.mutating}
                        onClick={() => void memory.decide(item, "reject").catch(fail)}
                      >
                        Reject
                      </Button>
                    </Show>
                    <Show
                      when={editing() === item.id}
                      fallback={
                        <Button size="small" disabled={!!memory.state.mutating} onClick={() => startEdit(item)}>
                          Edit
                        </Button>
                      }
                    >
                      <Button size="small" disabled={!!memory.state.mutating} onClick={() => void save(item)}>
                        Save
                      </Button>
                      <Button size="small" onClick={() => setEditing(undefined)}>
                        Cancel
                      </Button>
                    </Show>
                    <Show when={item.status === "active" || item.status === "paused"}>
                      <Button
                        size="small"
                        disabled={!!memory.state.mutating}
                        onClick={() => void memory.pause(item, item.status === "active").catch(fail)}
                      >
                        {item.status === "active" ? "Pause" : "Resume"}
                      </Button>
                    </Show>
                    <Button
                      size="small"
                      disabled={!!memory.state.mutating}
                      onClick={() => {
                        if (!window.confirm("Delete this Memory record?")) return
                        void memory.remove(item).catch(fail)
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </article>
              )}
            </For>
          </Show>

          <Show when={memory.state.nextCursor}>
            <Button disabled={memory.state.loadingMore} onClick={() => void memory.loadMore().catch(fail)}>
              Load more
            </Button>
          </Show>

          <div class="flex flex-wrap gap-2 border-t border-border-weak-base pt-4">
            <Button size="small" onClick={() => confirmClear("workspace")}>
              Clear workspace
            </Button>
            <Show when={memory.contentScope() === "personal"}>
              <Button size="small" onClick={() => confirmClear("relationship")}>
                Reset relationship
              </Button>
            </Show>
            <Button size="small" onClick={() => confirmClear("user_global")}>
              Clear global preferences
            </Button>
          </div>
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

function source(item: MemoryInfo) {
  if (item.sourceMessageID) return `message ${item.sourceMessageID}`
  if (item.sourceSessionID) return `session ${item.sourceSessionID}`
  return "direct"
}

function localDateTime(value: number) {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

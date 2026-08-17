import { For, Show, createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { Icon } from "@newhorse/ui/icon"
import { ScrollView } from "@newhorse/ui/scroll-view"
import { createStore } from "solid-js/store"
import type { Message, Part } from "@newhorse/sdk/v2/client"

const emptyMessages: Message[] = []

const formatTime = (locale: string, ts: number | undefined) => {
  if (!ts) return ""
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

const formatDuration = (start?: number, end?: number) => {
  if (!start || !end) return undefined
  const ms = Math.max(0, end - start)
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const snippet = (text: string, length = 120) => {
  const single = text.replace(/\s+/g, " ").trim()
  return single.length > length ? single.slice(0, length) + "…" : single
}

const inputSnippet = (input: Record<string, unknown>) => {
  const json = JSON.stringify(input)
  return json.length > 120 ? json.slice(0, 120) + "…" : json
}

type ToolRecord = {
  partID: string
  tool: string
  status: "pending" | "running" | "completed" | "error"
  title?: string
  input: Record<string, unknown>
  output?: string
  error?: string
  duration?: string
  time: number
}

const toolRecords = (messageID: string, parts: Part[]): ToolRecord[] => {
  const records: ToolRecord[] = []
  for (const part of parts) {
    if (part.type !== "tool") continue
    const state = part.state
    if (state.status === "completed") {
      records.push({
        partID: part.id,
        tool: part.tool,
        status: "completed",
        title: state.title,
        input: state.input,
        output: state.output,
        duration: formatDuration(state.time.start, state.time.end),
        time: state.time.end ?? state.time.start,
      })
      continue
    }
    if (state.status === "error") {
      records.push({
        partID: part.id,
        tool: part.tool,
        status: "error",
        input: state.input,
        error: state.error,
        duration: formatDuration(state.time.start, state.time.end),
        time: state.time.end ?? state.time.start,
      })
      continue
    }
    const running = state as { status: "running"; input: Record<string, unknown>; title?: string; time?: { start: number } }
    records.push({
      partID: part.id,
      tool: part.tool,
      status: state.status,
      title: running.title,
      input: running.input,
      time: running.time?.start ?? Date.now(),
    })
  }
  return records
}

export function SessionTrajectory(props: { onJumpToMessage: (messageID: string) => void }) {
  const sync = useSync()
  const language = useLanguage()
  const { params } = useSessionLayout()
  const [open, setOpen] = createStore<Record<string, boolean>>({})

  const messages = createMemo<Message[]>(() => {
    const id = params.id
    if (!id) return emptyMessages
    return (sync().data.message[id] ?? []) as Message[]
  })

  const partsFor = (id: string) => (sync().data.part[id] ?? []) as Part[]

  const turns = createMemo(() => {
    const all = messages()
    const parts = partsFor
    const result: {
      userID: string
      userText: string
      time: number
      compacted: boolean
      assistant: {
        messageID: string
        model: string
        error: boolean
        errorText?: string
        tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
        time: number
        tools: ToolRecord[]
        subtasks: { partID: string; agent: string; prompt: string }[]
        textPreview: string
      }[]
    }[] = []
    let current: (typeof result)[number] | undefined
    for (const message of all) {
      if (message.role === "user") {
        const messageParts = parts(message.id)
        const compaction = messageParts.find((part) => part.type === "compaction")
        current = {
          userID: message.id,
          userText: snippet(extractUserText(messageParts)),
          time: message.time.created,
          compacted: !!compaction,
          assistant: [],
        }
        result.push(current)
        continue
      }
      if (message.role !== "assistant") continue
      if (!current) {
        current = { userID: message.parentID, userText: "", time: message.time.created, compacted: false, assistant: [] }
        result.push(current)
      }
      const messageParts = parts(message.id)
      const errorText = message.error ? (message.error as { message?: string }).message ?? "error" : undefined
      const textParts = messageParts.filter(
        (part) => part.type === "text" && part.text.trim().length > 0,
      ) as { type: "text"; text: string }[]
      const subtasks = messageParts.filter(
        (part) => part.type === "subtask",
      ) as { type: "subtask"; id: string; agent: string; prompt: string }[]
      current.assistant.push({
        messageID: message.id,
        model: `${message.providerID}/${message.modelID}`,
        error: !!message.error,
        errorText,
        tokens: message.tokens,
        time: message.time.created,
        tools: toolRecords(message.id, messageParts),
        subtasks: subtasks.map((part) => ({ partID: part.id, agent: part.agent, prompt: part.prompt })),
        textPreview: snippet(textParts.map((part) => part.text).join("\n")),
      })
    }
    return result
  })

  const format = (value: number) => value.toLocaleString(language.intl())

  const toggle = (key: string) => setOpen(key, !open[key])

  return (
    <ScrollView class="h-full">
      <div class="mx-auto w-full max-w-3xl px-4 pb-10 pt-2 flex flex-col gap-1">
        <div class="px-1 pb-2 text-12-regular text-text-weak">
          {language.t("session.trajectory.description", { count: format(turns().length) })}
        </div>
        <For each={turns()}>
          {(turn, index) => (
            <div class="flex flex-col rounded-lg">
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-t-lg border border-border-weak-base bg-surface-base px-3 py-2 text-left transition-colors hover:bg-surface-subtle"
                onClick={() => toggle(`turn-${turn.userID}`)}
              >
                <Icon name="chevron-right" size="small" classList={{ "rotate-90 transition-transform": open[`turn-${turn.userID}`] }} />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-13-regular text-text-strong">
                    {turn.userText || language.t("session.trajectory.emptyPrompt")}
                  </div>
                  <div class="flex items-center gap-2 text-11-regular text-text-weaker">
                    <span>{language.t("session.trajectory.turn", { count: index() + 1 })}</span>
                    <span>·</span>
                    <span>{formatTime(language.intl(), turn.time)}</span>
                    <Show when={turn.compacted}>
                      <span class="rounded bg-surface-subtle px-1.5 py-0.5 text-text-weak">
                        {language.t("session.trajectory.compacted")}
                      </span>
                    </Show>
                  </div>
                </div>
                <div class="shrink-0 text-11-regular text-text-weaker">
                  {language.t("session.trajectory.messages", { count: turn.assistant.length })}
                </div>
              </button>

              <Show when={open[`turn-${turn.userID}`]}>
                <div class="rounded-b-lg border border-t-0 border-border-weak-base bg-surface-base px-3 pb-3">
                  <div class="flex flex-col">
                    <For each={turn.assistant}>
                      {(assistant) => (
                        <div class="border-l-2 border-border-weak-base pl-3">
                          <div class="relative">
                            <div
                              class="absolute -left-[15px] top-2.5 size-1.5 rounded-full"
                              classList={{
                                "bg-text-danger": assistant.error,
                                "bg-text-interactive-base": !assistant.error,
                              }}
                            />
                            <button
                              type="button"
                              class="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface-subtle"
                              onClick={() => toggle(`msg-${assistant.messageID}`)}
                            >
                              <Icon
                                name={assistant.error ? "warning" : "speech-bubble"}
                                size="small"
                                classList={{ "text-text-danger": assistant.error, "text-icon-base": !assistant.error }}
                              />
                              <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2">
                                  <span class="truncate font-mono text-11-regular text-text-weak">{assistant.model}</span>
                                  <Show when={assistant.error}>
                                    <span class="shrink-0 rounded bg-text-danger/10 px-1.5 py-0.5 text-10-medium text-text-danger">
                                      {language.t("session.trajectory.error")}
                                    </span>
                                  </Show>
                                </div>
                                <Show when={assistant.textPreview}>
                                  <div class="truncate text-12-regular text-text-base">{assistant.textPreview}</div>
                                </Show>
                              </div>
                              <div class="shrink-0 text-11-regular text-text-weaker">
                                {format(assistant.tokens.input + assistant.tokens.cache.read + assistant.tokens.cache.write)}t
                              </div>
                            </button>
                            <Show when={open[`msg-${assistant.messageID}`]}>
                              <div class="flex flex-col gap-2 pb-2 pl-4">
                                <div class="flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-surface-subtle px-2 py-1.5 text-11-regular text-text-weak">
                                  <span>{language.t("session.trajectory.input")} {format(assistant.tokens.input)}</span>
                                  <span>{language.t("session.trajectory.output")} {format(assistant.tokens.output)}</span>
                                  <span>{language.t("session.trajectory.reasoning")} {format(assistant.tokens.reasoning)}</span>
                                  <span>
                                    {language.t("session.trajectory.cache")} {format(assistant.tokens.cache.read)} /{" "}
                                    {format(assistant.tokens.cache.write)}
                                  </span>
                                </div>
                                <Show when={assistant.errorText}>
                                  <div class="rounded-md border border-text-danger/30 bg-text-danger/5 px-2 py-1.5 text-11-regular text-text-danger break-all">
                                    {assistant.errorText}
                                  </div>
                                </Show>
                                <Show when={assistant.subtasks.length > 0}>
                                  <For each={assistant.subtasks}>
                                    {(subtask) => (
                                      <button
                                        type="button"
                                        class="flex items-start gap-2 rounded-md border border-border-weak-base bg-surface-raised-base px-2 py-1.5 text-left transition-colors hover:bg-surface-subtle"
                                        onClick={() => props.onJumpToMessage(turn.userID)}
                                      >
                                        <Icon name="subagent" size="small" class="mt-0.5 shrink-0 text-icon-weak" />
                                        <div class="min-w-0">
                                          <div class="text-12-regular text-text-strong">
                                            {language.t("session.trajectory.subagent")} <span class="font-mono">{subtask.agent}</span>
                                          </div>
                                          <div class="truncate text-11-regular text-text-weaker">{snippet(subtask.prompt)}</div>
                                        </div>
                                      </button>
                                    )}
                                  </For>
                                </Show>
                                <For each={assistant.tools}>
                                  {(tool) => (
                                    <button
                                      type="button"
                                      class="flex items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-surface-subtle"
                                      classList={{
                                        "border-text-danger/30 bg-text-danger/5": tool.status === "error",
                                        "border-border-weak-base bg-surface-raised-base": tool.status !== "error",
                                      }}
                                      onClick={() => props.onJumpToMessage(turn.userID)}
                                    >
                                      <Icon
                                        name={tool.status === "error" ? "warning" : "console"}
                                        size="small"
                                        classList={{ "mt-0.5 shrink-0": true, "text-text-danger": tool.status === "error", "text-icon-weak": tool.status !== "error" }}
                                      />
                                      <div class="min-w-0 flex-1">
                                        <div class="flex items-center gap-2">
                                          <span class="truncate font-mono text-12-regular text-text-strong">{tool.tool}</span>
                                          <Show when={tool.duration}>
                                            <span class="shrink-0 text-10-regular text-text-weaker">{tool.duration}</span>
                                          </Show>
                                          <Show when={tool.status === "error"}>
                                            <span class="shrink-0 rounded bg-text-danger/10 px-1.5 py-0.5 text-10-medium text-text-danger">
                                              {language.t("session.trajectory.error")}
                                            </span>
                                          </Show>
                                        </div>
                                        <div class="truncate font-mono text-11-regular text-text-weaker">{inputSnippet(tool.input)}</div>
                                        <Show when={tool.output}>
                                          <div class="truncate text-11-regular text-text-weak">{snippet(tool.output!, 160)}</div>
                                        </Show>
                                        <Show when={tool.error}>
                                          <div class="truncate text-11-regular text-text-danger">{snippet(tool.error!, 160)}</div>
                                        </Show>
                                      </div>
                                    </button>
                                  )}
                                </For>
                                <div class="text-right">
                                  <button
                                    type="button"
                                    class="text-11-regular text-text-weaker transition-colors hover:text-text-base"
                                    onClick={() => props.onJumpToMessage(assistant.messageID)}
                                  >
                                    {language.t("session.trajectory.jumpToMessage")} →
                                  </button>
                                </div>
                              </div>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </ScrollView>
  )
}

const extractUserText = (parts: Part[]) => {
  const texts = parts
    .filter((part) => part.type === "text" && part.text.trim().length > 0)
    .map((part) => (part as { type: "text"; text: string }).text)
  if (texts.length > 0) return texts.join("\n")
  const file = parts.find((part) => part.type === "file") as { type: "file"; filename?: string } | undefined
  if (file) return `[file: ${file.filename ?? "attachment"}]`
  const agent = parts.find((part) => part.type === "agent") as { type: "agent"; name: string } | undefined
  if (agent) return `[@${agent.name}]`
  return ""
}
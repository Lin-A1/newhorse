import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Spinner } from "@newhorse/ui/spinner"
import { Icon } from "@newhorse/ui/icon"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { deriveSessionTasks, type SessionTask } from "@/components/session-tasks"

const emptyTasks: SessionTask[] = []

export function createSessionTasksState(input: { sessionID: () => string | undefined }) {
  const language = useLanguage()
  const sync = useSync()

  const tasks = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID) return emptyTasks
    return deriveSessionTasks({
      messages: sync().data.message[sessionID] ?? [],
      parts: (messageID) => sync().data.part[messageID],
      status: (childID) => sync().data.session_status[childID],
    })
  })
  const running = createMemo(() => tasks().filter((task) => task.background && task.state === "running").length)
  const [badge, setBadge] = createSignal(0)

  let previous = new Set<string>()
  let previousSession: string | undefined
  let runningBefore = 0
  let batchCount = 0
  let batchShown = false
  let booted = false
  let timer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    if (previousSession !== sessionID) {
      previousSession = sessionID
      previous = new Set()
      runningBefore = 0
      batchCount = 0
      batchShown = false
      booted = false
      setBadge(0)
    }
    const list = tasks()
    const currentRunning = list.filter((task) => task.background && task.state === "running")
    const currentTerminal = new Set(list.filter((task) => task.background && task.state !== "running").map((t) => t.id))
    const freshlyDone = list.filter((task) => task.background && task.state !== "running" && !previous.has(task.id))
    const beforeRunning = runningBefore
    runningBefore = currentRunning.length
    if (!booted) {
      booted = true
      previous = currentTerminal
      return
    }
    previous = currentTerminal

    if (freshlyDone.length > 0) {
      batchCount += freshlyDone.length
      setBadge((value) => value + freshlyDone.length)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => setBadge(0), 8_000)
    }

    if (beforeRunning > 0 && currentRunning.length === 0 && batchCount > 0 && !batchShown) {
      batchShown = true
      const failed = freshlyDone.filter((task) => task.state === "error").length
      showToast({
        variant: failed > 0 ? "default" : "success",
        title: language.t(
          failed > 0 ? "session.tasks.allComplete.failed" : "session.tasks.allComplete.done",
          { count: String(batchCount), errors: String(failed) },
        ),
      })
    }
  })

  return { tasks, running, badge }
}

export function SessionTasksPanel(props: { tasks: () => SessionTask[] }) {
  const language = useLanguage()
  const list = createMemo(() => {
    const items = props.tasks()
    return [...items].sort((a, b) => {
      if (a.state === "running" && b.state !== "running") return -1
      if (b.state === "running" && a.state !== "running") return 1
      return a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1)
    })
  })
  return (
    <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
      <div class="h-full flex flex-col">
        <Show
          when={list().length > 0}
          fallback={<div class="flex-1 px-6 flex items-center justify-center text-12-regular text-text-weak">{language.t("session.tasks.empty")}</div>}
        >
          <div class="flex-1 min-h-0 overflow-y-auto px-3 pb-4 flex flex-col gap-1">
            <For each={list()}>{(task) => <SessionTaskRow task={task} />}</For>
          </div>
        </Show>
      </div>
    </div>
  )
}

function SessionTaskRow(props: { task: SessionTask }) {
  const language = useLanguage()
  const label = createMemo(() => {
    if (props.task.state === "running") return language.t("session.tasks.state.running")
    if (props.task.state === "error") return language.t("session.tasks.state.error")
    return language.t("session.tasks.state.completed")
  })
  const detail = createMemo(() => {
    const agent = props.task.agent ? language.t("session.tasks.subagent", { agent: props.task.agent }) : ""
    if (props.task.state !== "running" && props.task.summary) return props.task.summary
    return [label(), agent].filter(Boolean).join(" · ")
  })
  return (
    <div
      data-slot="session-task"
      data-task-id={props.task.id}
      data-task-state={props.task.state}
      class="flex items-start gap-2 rounded-md px-2 py-1.5 bg-background-stronger"
    >
      <Show
        when={props.task.state === "running"}
        fallback={
          <Show
            when={props.task.state === "completed"}
            fallback={<Icon name="circle-ban-sign" size="small" class="mt-0.5 shrink-0 text-icon-critical-base" />}
          >
            <Icon name="circle-check" size="small" class="mt-0.5 shrink-0 text-icon-success-base" />
          </Show>
        }
      >
        <Spinner class="mt-0.5 size-3 shrink-0 text-text-weak" />
      </Show>
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-regular text-text-strong">{props.task.title}</div>
        <div class="truncate text-12-regular text-text-weak">{detail()}</div>
      </div>
      <Show when={props.task.background}>
        <span class="shrink-0 mt-0.5 rounded px-1 py-0.5 text-10-regular text-text-weaker bg-background-weak">
          {language.t("session.tasks.background")}
        </span>
      </Show>
    </div>
  )
}
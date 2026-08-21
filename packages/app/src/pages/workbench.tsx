import { createMemo, createResource, createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ScrollView } from "@newhorse/ui/scroll-view"
import { Icon as IconV2 } from "@newhorse/ui/v2/icon"
import { ButtonV2 } from "@newhorse/ui/v2/button-v2"
import { SidebarTimeline } from "@/components/sidebar-timeline"
import { SettingsUsage } from "@/components/settings-usage"
import {
  HOUR_MS,
  appColorIndex,
  buildCompressedGaps,
  compressedRatioToPercent,
  compressedTotalMs,
  dayStartMs,
  groupSegments,
  timeToCompressedRatio,
  timelineEndHour,
} from "@/lib/presence-gantt"

type WorkbenchTodo = {
  id: string
  content: string
  status: "open" | "in_progress" | "done" | "cancelled"
  source: "user" | "newhorse" | "reminder"
}

type WorkbenchSection = "overview" | "todos" | "usage" | "summary"

function presenceLabel(language: ReturnType<typeof useLanguage>, idleMs: number) {
  const minutes = Math.floor(idleMs / 60_000)
  if (minutes < 1) return language.t("workbench.presence.active")
  return language.t("workbench.presence.idle", { minutes: String(minutes) })
}

function WorkbenchTodos() {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const [input, setInput] = createSignal("")
  const [todos, { refetch }] = createResource(async () => {
    const res = await serverSDK().client.workbench.list().catch(() => undefined)
    return res?.data ?? []
  })

  const add = async () => {
    const content = input().trim()
    if (!content) return
    setInput("")
    try {
      await serverSDK().client.workbench.create({ content })
      await refetch()
    } catch {
      // Keep the typed text on failure so the user can retry.
      setInput(content)
    }
  }

  const setStatus = async (todo: WorkbenchTodo, status: "open" | "in_progress" | "done" | "cancelled") => {
    try {
      await serverSDK().client.workbench.update({ todoID: todo.id, status })
      await refetch()
    } catch {
      // Invalid transitions are rejected server-side; surface nothing.
    }
  }

  const remove = async (todo: WorkbenchTodo) => {
    try {
      await serverSDK().client.workbench.remove({ todoID: todo.id })
      await refetch()
    } catch {
      // no-op
    }
  }

  return (
    <section class="flex min-w-0 flex-col gap-3">
      <h2 class="text-[13px] font-medium tracking-[-0.04px] text-v2-text-text-muted">{language.t("workbench.todo")}</h2>
      <div class="flex items-center gap-2">
        <input
          type="text"
          value={input()}
          placeholder={language.t("workbench.addTodoPlaceholder")}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add()
          }}
          class="min-w-0 flex-1 rounded-[6px] border border-v2-border-border-muted bg-v2-background-bg-base px-2.5 py-1.5 text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint focus:border-v2-border-border-active"
        />
        <ButtonV2 size="small" variant="outline" onClick={() => void add()} disabled={!input().trim()}>
          {language.t("workbench.add")}
        </ButtonV2>
      </div>
      <div class="flex min-h-0 flex-1 flex-col">
        <Show
          when={(todos()?.length ?? 0) > 0}
          fallback={<div class="text-[13px] leading-5 text-v2-text-text-faint">{language.t("workbench.todoEmpty")}</div>}
        >
          <For each={todos()}>
            {(todo) => (
              <div class="group flex items-center gap-2 border-b border-v2-border-border-muted py-1.5 last:border-b-0">
                <button
                  type="button"
                  aria-label={language.t("workbench.toggle")}
                  onClick={() => setStatus(todo, todo.status === "done" ? "open" : "done")}
                  class="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-v2-border-border-muted text-v2-text-text-faint transition-colors hover:border-v2-border-border-active data-[done='true']:border-v2-border-border-active"
                  data-done={todo.status === "done"}
                >
                  <Show when={todo.status === "done"}>
                    <IconV2 name="check" size="small" />
                  </Show>
                </button>
                <span
                  class={`min-w-0 flex-1 truncate text-[13px] leading-5 text-v2-text-text-base ${
                    todo.status === "done" ? "line-through text-v2-text-text-faint" : ""
                  }`}
                >
                  {todo.content}
                </span>
                <Show when={todo.source === "newhorse"}>
                  <span class="shrink-0 rounded-[4px] bg-v2-background-bg-layer-04 px-1.5 py-0.5 text-[10px] text-v2-text-text-faint">
                    {language.t("workbench.sourceNewhorse")}
                  </span>
                </Show>
                <button
                  type="button"
                  aria-label={language.t("workbench.remove")}
                  onClick={() => void remove(todo)}
                  class="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-v2-icon-icon-muted opacity-0 transition-opacity hover:bg-v2-overlay-simple-overlay-hover group-hover:opacity-100"
                >
                  <IconV2 name="close" size="small" />
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </section>
  )
}

function PresenceStrip() {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const platform = usePlatform()
  const [presence, { refetch }] = createResource(async () => {
    // Desktop-first: real idle/lock/focus from the host. Fall back to the
    // server-derived idle (last session activity) on web.
    const desktop = await platform.getPresence?.().catch(() => undefined)
    if (desktop) {
      return {
        idleMs: desktop.idleSeconds * 1000,
        locked: desktop.locked,
        focusApp: desktop.focusedApp,
        inMeeting: desktop.inMeeting ?? false,
        observedAt: Date.now(),
      }
    }
    const res = await serverSDK().client.presence.current().catch(() => undefined)
    return res?.data
  })

  onMount(() => {
    const timer = setInterval(() => void Promise.resolve(refetch()), 15_000)
    onCleanup(() => clearInterval(timer))
  })

  const activityLevel = (idleMs: number): 0 | 1 | 2 | 3 => {
    if (idleMs < 60_000) return 3
    if (idleMs < 5 * 60_000) return 2
    if (idleMs < 30 * 60_000) return 1
    return 0
  }

  const idleMs = () => Number(presence()?.idleMs ?? Infinity)

  return (
    <section class="flex items-center gap-2.5">
      <span class="relative flex size-2 shrink-0">
        <span
          class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
          classList={{
            "bg-v2-accent-accent": idleMs() < 60_000,
            "bg-v2-warning-warning": idleMs() >= 60_000,
          }}
        />
        <span
          class="relative inline-flex size-2 rounded-full"
          classList={{
            "bg-v2-accent-accent": idleMs() < 60_000,
            "bg-v2-warning-warning": idleMs() >= 60_000,
          }}
        />
      </span>
      <div class="min-w-0">
        <div class="text-[13px] font-medium text-v2-text-text-base">
          {language.t("workbench.presence.title")}
        </div>
        <Show when={presence()}>
          <div class="flex flex-col gap-1 text-[12px] leading-4 text-v2-text-text-faint">
            <div class="flex items-center gap-1.5">
              <span class="mr-0.5 tracking-tight" aria-hidden="true">
                {"●".repeat(activityLevel(idleMs())) + "○".repeat(3 - activityLevel(idleMs()))}
              </span>
              <span>{presenceLabel(language, idleMs())}</span>
              <Show when={presence()!.locked}>
                <span class="ml-1 rounded-[4px] border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-1 py-px text-[10px] text-v2-text-text-muted">
                  {language.t("workbench.presence.locked")}
                </span>
              </Show>
              <Show when={presence()!.inMeeting}>
                <span class="ml-1 rounded-[4px] border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-1 py-px text-[10px] text-v2-text-text-muted">
                  {language.t("workbench.presence.meeting")}
                </span>
              </Show>
            </div>
            <Show when={presence()!.focusApp}>
              <div class="flex items-center gap-1.5">
                <span class="inline-block size-1.5 shrink-0 rounded-full bg-v2-accent-accent" aria-hidden="true" />
                <span class="truncate text-v2-text-text-base">
                  {language.t("workbench.presence.focusing")}
                  <span class="ml-1 rounded-[4px] bg-v2-background-bg-layer-02 px-1.5 py-px text-[11px] font-medium text-v2-text-text-base">
                    {presence()!.focusApp}
                  </span>
                </span>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={!presence.loading && !presence()}>
          <div class="text-[12px] leading-4 text-v2-text-text-faint">
            {language.t("common.requestFailed")}
          </div>
        </Show>
      </div>
    </section>
  )
}

function PresenceGantt() {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const [timeline, { refetch }] = createResource(async () => {
    const res = await serverSDK().client.presence.timeline().catch(() => undefined)
    return res?.data
  })

  onMount(() => {
    const timer = setInterval(() => void Promise.resolve(refetch()), 15_000)
    onCleanup(() => clearInterval(timer))
  })

  const num = (value: number | string | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback
  const formatHour = (value: number | string) => {
    const d = new Date(num(value, Date.now()))
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }

  const now = () => Date.now()
  const dayStart = () => dayStartMs(now())
  const endHour = () => timelineEndHour(now())
  const endMs = () => dayStart() + endHour() * HOUR_MS
  const rows = createMemo(() => groupSegments(timeline()?.segments ?? [], now()))
  const live = () => timeline()?.live === true
  const gaps = createMemo(() => buildCompressedGaps(rows(), dayStart(), endMs()))
  const totalCompressed = createMemo(() => compressedTotalMs(dayStart(), endMs(), gaps()))

  const palette = [
    "#b77561",
    "#b9965e",
    "#6f9aa4",
    "#83a276",
    "#8a96b4",
    "#a77f9c",
    "#9284b8",
    "#829b8a",
  ]
  const color = (app: string) => palette[appColorIndex(app, palette.length)]
  const ticks = () => Array.from({ length: endHour() / 2 - 1 }, (_, index) => (index + 1) * 2).filter((hour) => {
    const time = dayStart() + hour * HOUR_MS
    return !gaps().some((gap) => time >= gap.start && time <= gap.end)
  })

  const tickLeft = (hour: number) => {
    const time = dayStart() + hour * HOUR_MS
    const ratio = timeToCompressedRatio(time, dayStart(), gaps())
    return compressedRatioToPercent(ratio, totalCompressed())
  }
  const segmentStyle = (start: number, end: number) => {
    const clampedStart = Math.max(start, dayStart())
    const clampedEnd = Math.min(end, endMs())
    if (clampedEnd <= clampedStart) return null
    const startRatio = timeToCompressedRatio(clampedStart, dayStart(), gaps())
    const endRatio = timeToCompressedRatio(clampedEnd, dayStart(), gaps())
    const left = compressedRatioToPercent(startRatio, totalCompressed())
    const right = compressedRatioToPercent(endRatio, totalCompressed())
    const width = Math.max(0.45, right - left)
    return { left, width: Math.min(100 - left, width) }
  }

  return (
    <Show when={rows().length > 0}>
      <div class="overflow-x-auto pb-1 no-scrollbar">
        <div class="min-w-[720px]">
          <div class="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-x-4 border-b border-v2-border-border-muted pb-4">
            <div class="flex items-center gap-2 text-[15px] font-semibold text-v2-text-text-strong">
              {language.t("workbench.presence.gantt")}
              <Show when={live()}>
                <span class="inline-block size-1.5 rounded-full bg-v2-accent-accent" aria-hidden="true" />
              </Show>
            </div>
            <div class="flex flex-wrap gap-x-4 gap-y-2 pt-0.5">
              <For each={rows()}>
                {(row) => (
                  <div class="flex min-w-0 items-center gap-1.5 text-[11px] text-v2-text-text-muted">
                    <span class="size-3 shrink-0 rounded-[3px]" style={{ "background-color": color(row.app) }} />
                    <span class="max-w-28 truncate" title={row.app}>
                      {row.app}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
          <div class="grid grid-cols-[150px_minmax(0,1fr)] gap-x-4 pt-5">
            <div class="flex flex-col">
              <For each={rows()}>
                {(row) => (
                  <div class="flex h-11 items-center justify-end truncate pr-1 text-[12px] text-v2-text-text-muted" title={row.app}>
                    {row.app}
                  </div>
                )}
              </For>
            </div>
            <div class="relative border-l border-v2-border-border-strong">
              <For each={ticks()}>
                {(hour) => (
                  <div
                    class="absolute inset-y-0 border-l border-v2-border-border-muted/60"
                    style={{ left: `${tickLeft(hour)}%` }}
                  >
                    <span class="absolute -bottom-6 -translate-x-1/2 whitespace-nowrap text-[10px] text-v2-text-text-faint">
                      {String(hour).padStart(2, "0")}:00
                    </span>
                  </div>
                )}
              </For>
              {/* Compressed gap break markers */}
              <For each={gaps()}>
                {(gap) => {
                  const ratio = timeToCompressedRatio(gap.start, dayStart(), gaps())
                  const left = compressedRatioToPercent(ratio, totalCompressed())
                  return (
                    <div
                      class="absolute inset-y-0 flex items-center justify-center"
                      style={{ left: `calc(${left}% - 8px)` }}
                      title={`压缩空白 ${Math.round(gap.duration / 60000)}m → 14m`}
                    >
                      <span class="rounded-[4px] bg-v2-background-bg-layer-02 px-1 py-0.5 text-[9px] font-medium leading-none text-v2-text-text-faint shadow-sm ring-1 ring-v2-border-border-muted">
                        //
                      </span>
                    </div>
                  )
                }}
              </For>
              <For each={rows()}>
                {(row) => (
                  <div class="relative h-11">
                    <For each={row.segments}>
                      {(segment) => {
                        const style = segmentStyle(segment.start, segment.end)
                        if (!style) return null
                        return (
                          <div
                            class="absolute top-2 h-7 rounded-[4px] opacity-90"
                            style={{
                              left: `${style.left}%`,
                              width: `${style.width}%`,
                              "background-color": color(row.app),
                            }}
                            title={`${row.app} - ${formatHour(segment.start)}-${formatHour(segment.end)}`}
                          />
                        )
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>
          <div class="h-7" />
        </div>
      </div>
    </Show>
  )
}

export default function WorkbenchPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const [section, setSection] = createSignal<WorkbenchSection>("overview")
  // Keep the scroll position across section switches and data refreshes so the
  // page never jumps back to the top.
  let scrollTop = 0
  let viewport: HTMLDivElement | undefined
  let restoreFrame: number | undefined

  const rememberScroll = (el: HTMLDivElement) => {
    scrollTop = el.scrollTop
  }

  const restoreScroll = () => {
    if (!viewport) return
    if (viewport.scrollTop !== scrollTop) viewport.scrollTop = scrollTop
  }

  const scheduleRestore = () => {
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restoreScroll()
    })
  }
  let contentEl: HTMLDivElement | undefined
  let contentObserver: MutationObserver | undefined
  const watchContent = (el: HTMLDivElement) => {
    if (contentEl === el) return
    contentEl = el
    contentObserver?.disconnect()
    contentObserver = new MutationObserver(scheduleRestore)
    contentObserver.observe(el, { childList: true, subtree: true })
    scheduleRestore()
  }
  onCleanup(() => {
    contentObserver?.disconnect()
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  const switchSection = (next: WorkbenchSection) => {
    // Reset scroll when switching pages (fresh page start), keep it across data
    // refreshes within a page.
    if (next !== section()) scrollTop = 0
    setSection(next)
  }

  const SECTIONS: { key: WorkbenchSection; label: string }[] = [
    { key: "overview", label: language.t("workbench.section.overview") },
    { key: "todos", label: language.t("workbench.todo") },
    { key: "usage", label: language.t("workbench.usage") },
    { key: "summary", label: language.t("workbench.dailySummary") },
  ]

  return (
    <div class="m-2 min-h-0 self-stretch flex-1 overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <div class="flex h-full flex-col">
        {/* Header with back + title */}
        <header class="flex shrink-0 items-center justify-between gap-3 px-4 pt-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-[6px] text-v2-icon-icon-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover"
              onClick={() => navigate("/")}
              aria-label={language.t("common.back")}
            >
              <IconV2 name="chevron-left" size="small" />
            </button>
            <h1 class="text-[18px] font-medium tracking-[-0.13px] text-v2-text-text-strong">
              {language.t("workbench.title")}
            </h1>
          </div>
        </header>

        {/* Section tabs */}
        <nav class="flex shrink-0 items-center gap-1.5 px-4 pt-3" aria-label={language.t("workbench.title")}>
          <For each={SECTIONS}>
            {(item) => (
              <button
                type="button"
                class="relative rounded-[6px] px-3 py-1.5 text-[13px] font-medium transition-colors"
                classList={{
                  "text-v2-text-text-strong": section() === item.key,
                  "text-v2-text-text-faint hover:text-v2-text-text-base": section() !== item.key,
                }}
                onClick={() => switchSection(item.key)}
                aria-current={section() === item.key ? "page" : undefined}
              >
                {item.label}
                {/* Active underline indicator */}
                <span
                  class="absolute inset-x-2 -bottom-px h-0.5 rounded-full"
                  classList={{
                    "bg-v2-accent-accent": section() === item.key,
                    "bg-transparent": section() !== item.key,
                  }}
                />
              </button>
            )}
          </For>
        </nav>

        {/* Section content */}
        <ScrollView
          class="min-h-0 flex-1 [container-type:size]"
          viewportRef={(el) => {
            viewport = el
            restoreScroll()
          }}
          onScroll={(e) => rememberScroll(e.currentTarget as HTMLDivElement)}
        >
          <div ref={watchContent} class="mx-auto flex min-h-full w-full max-w-[1320px] flex-col gap-5 px-5 py-6">
            <Show when={section() === "overview"}>
              <div class="flex flex-col gap-1 px-1">
                <h2 class="text-[14px] font-semibold tracking-[-0.04px] text-v2-text-text-strong">
                  {language.t("workbench.section.overview")}
                </h2>
                <p class="text-[12px] leading-4 text-v2-text-text-faint">
                  {language.t("workbench.overview.subtitle") ?? "Activity, presence and recent daily digests at a glance."}
                </p>
              </div>
              <div class="grid min-h-0 grid-cols-1 gap-5">
                <section class="flex min-h-0 flex-col gap-4 rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-5 shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
                  <PresenceStrip />
                  <div class="h-px bg-v2-border-border-muted/70" />
                  <PresenceGantt />
                </section>
              </div>
              <section class="flex min-h-0 w-full flex-col gap-3 rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-5 shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2.5">
                    <span class="flex size-7 items-center justify-center rounded-[8px] bg-v2-background-bg-layer-03 text-v2-text-text-muted">
                      <IconV2 name="calendar" size="small" />
                    </span>
                    <div class="flex flex-col">
                      <span class="text-[13px] font-semibold leading-4 text-v2-text-text-strong">
                        {language.t("workbench.dailySummary")}
                      </span>
                      <span class="text-[11px] leading-3 text-v2-text-text-faint">
                        {language.t("sidebar.dailySummary.subtitle") ?? "Recent digests — polished vertical timeline"}
                      </span>
                    </div>
                  </div>
                  <ButtonV2 size="small" variant="ghost-muted" onClick={() => switchSection("summary")}>
                    {language.t("common.viewAll") ?? "View all"}
                  </ButtonV2>
                </div>
                <div class="min-h-0 flex-1 rounded-[10px] border border-v2-border-border-muted/60 bg-v2-background-bg-base px-4 py-4">
                  <SidebarTimeline showHeader={false} bodyClass="px-1 pb-1" />
                </div>
              </section>
            </Show>

            <Show when={section() === "todos"}>
              <section class="flex min-h-0 flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
                <WorkbenchTodos />
              </section>
            </Show>

            <Show when={section() === "usage"}>
              <section class="rounded-[10px] bg-v2-background-bg-layer-01 p-4">
                <SettingsUsage />
              </section>
            </Show>

            <Show when={section() === "summary"}>
              <section class="flex min-h-0 flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
                <h2 class="text-[13px] font-medium tracking-[-0.04px] text-v2-text-text-muted">
                  {language.t("workbench.dailySummary")}
                </h2>
                <div class="min-h-0 flex-1">
                  <SidebarTimeline showHeader={false} bodyClass="px-0 pb-0" />
                </div>
              </section>
            </Show>
          </div>
        </ScrollView>
      </div>
    </div>
  )
}

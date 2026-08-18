import { createResource, createSignal, For, Show } from "solid-js"
import { DateTime } from "luxon"
import { useNavigate } from "@solidjs/router"
import { Markdown } from "@newhorse/session-ui/markdown"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"

/**
 * Daily summary timeline: a day-granularity axis — one node per day, joined by
 * a vertical line, showing the AI-generated digest the newhorse `daily-summary`
 * tool produces (auto-generated each day, no manual trigger).
 *
 * Dual-mode: a horizontal date slider (今天 → 昨天 → M月d日) sits above the axis.
 * Clicking a date chip focuses that single day (detail mode); clicking again or
 * pressing the "all" chip restores the full list. The vertical axis doubles as
 * the event timeline, and each node navigates to the full daily report.
 *
 * Embeddable in a sidebar: `showHeader` hides the built-in title when a custom
 * header is provided, `class` constrains the root height (e.g. `max-h-52` to
 * cap the block and enable internal scrolling), and `bodyClass` tunes padding.
 */
export function SidebarTimeline(props: {
  /** Show the built-in "Daily summary" header. Defaults to true. */
  showHeader?: boolean
  /** Extra classes for the root, e.g. `max-h-52` to cap height and enable scrolling. */
  class?: string
  /** Extra classes for the scrollable body (padding, etc). */
  bodyClass?: string
}) {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const navigate = useNavigate()
  const [summaries] = createResource(async () => {
    const res = await serverSDK().client.dailySummary.list().catch(() => undefined)
    return res?.data ?? []
  })
  const showHeader = props.showHeader ?? true
  // 当前聚焦的日期 key（yyyy-MM-dd）；null = 全部
  const [focused, setFocused] = createSignal<string | null>(null)

  const label = (date: string) => {
    const parsed = DateTime.fromISO(date)
    if (!parsed.isValid) return date
    const now = DateTime.local()
    if (parsed.hasSame(now, "day")) return language.t("home.sessions.group.today")
    if (parsed.hasSame(now.minus({ days: 1 }), "day")) return language.t("home.sessions.group.yesterday")
    return parsed.toFormat(parsed.year === now.year ? "M月d日" : "yyyy年M月d日")
  }

  const shortLabel = (date: string) => {
    const parsed = DateTime.fromISO(date)
    if (!parsed.isValid) return date
    const now = DateTime.local()
    if (parsed.hasSame(now, "day")) return language.t("home.sessions.group.today")
    if (parsed.hasSame(now.minus({ days: 1 }), "day")) return language.t("home.sessions.group.yesterday")
    return parsed.toFormat("M/d")
  }

  const focusDate = (date: string) => {
    setFocused(date)
    // 定位到对应节点
    document.querySelector(`[data-summary-date="${date}"]`)?.scrollIntoView({ block: "nearest" })
  }

  const visible = () => {
    const all = summaries()
    if (!all) return []
    const f = focused()
    if (!f) return all
    return all.filter((s) => s.date === f)
  }

  return (
    <div class={`flex min-w-0 min-h-0 flex-col overflow-hidden ${props.class ?? ""}`}>
      <Show when={showHeader}>
        <div class="flex items-center justify-between gap-2 px-5 pt-5 pb-3">
          <h2 class="text-[15px] font-medium tracking-[-0.13px] text-v2-text-text-strong">
            {language.t("sidebar.dailySummary")}
          </h2>
        </div>
      </Show>
      <Show when={(summaries()?.length ?? 0) > 0}>
        {/* 横向日期滑动条：今天 → 昨天 → M月d日；点击聚焦单日，再点恢复全部 */}
        <div class="shrink-0 px-3 pb-2">
          <div class="flex gap-1 overflow-x-auto no-scrollbar" role="tablist" aria-label="daily summary dates">
            <button
              type="button"
              role="tab"
              aria-selected={focused() === null}
              class="shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] leading-4 transition-colors"
              classList={{
                "border-v2-border-border-active bg-v2-background-bg-layer-03 text-v2-text-text-base": focused() === null,
                "border-v2-border-border-muted text-v2-text-text-faint hover:text-v2-text-text-muted":
                  focused() !== null,
              }}
              onClick={() => setFocused(null)}
            >
              {language.t("workbench.all")}
            </button>
            <For each={summaries()}>
              {(s) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={focused() === s.date}
                  class="shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] leading-4 transition-colors"
                  classList={{
                    "border-v2-border-border-active bg-v2-background-bg-layer-03 text-v2-text-text-base":
                      focused() === s.date,
                    "border-v2-border-border-muted text-v2-text-text-faint hover:text-v2-text-text-muted":
                      focused() !== s.date,
                  }}
                  onClick={() => (focused() === s.date ? setFocused(null) : focusDate(s.date))}
                >
                  {shortLabel(s.date)}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div class={`flex-[1_1_auto] min-h-0 overflow-y-auto no-scrollbar ${props.bodyClass ?? "px-5 pb-6"}`}>
        <Show
          when={!summaries.loading && visible().length > 0}
          fallback={
            <div class="text-[13px] leading-5 text-v2-text-text-faint">{language.t("sidebar.dailySummary.empty")}</div>
          }
        >
          <div class="flex flex-col">
            <For each={visible()}>
              {(s) => (
                <button
                  type="button"
                  data-summary-date={s.date}
                  class="relative block w-full border-l border-v2-border-border-muted pl-4 pb-5 text-left last:pb-0"
                  classList={{
                    "[&_.summary-date-label]:text-v2-text-text-base": focused() === s.date,
                  }}
                  onClick={() => {
                    setFocused(s.date)
                    navigate("/daily")
                  }}
                >
                  <span
                    aria-hidden="true"
                    class="absolute -left-[5px] top-1 size-2 rounded-full bg-v2-background-bg-layer-04 ring-2 ring-v2-background-bg-base"
                    classList={{ "bg-v2-accent-accent": focused() === s.date }}
                  />
                  <div class="summary-date-label text-[12px] font-medium leading-4 text-v2-text-text-muted">
                    {label(s.date)}
                  </div>
                  <div class="text-[11px] leading-4 text-v2-text-text-faint">
                    {DateTime.fromISO(s.date).isValid ? DateTime.fromISO(s.date).toFormat("yyyy-MM-dd") : s.date}
                  </div>
                  <Markdown
                    text={s.overview}
                    class="mt-1 line-clamp-3 text-[13px] leading-5 text-v2-text-text-base"
                  />
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

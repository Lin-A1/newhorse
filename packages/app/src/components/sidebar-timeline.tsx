import { createResource, For, Show } from "solid-js"
import { DateTime } from "luxon"
import { useNavigate } from "@solidjs/router"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"

/**
 * Daily summary timeline: a day-granularity axis — one node per day, joined by
 * a vertical line, showing the AI-generated digest the newhorse `daily-summary`
 * tool produces (auto-generated each day, no manual trigger).
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
    const res = await serverSDK().client.dailySummary.list()
    return res.data ?? []
  })
  const showHeader = props.showHeader ?? true

  const label = (date: string) => {
    const parsed = DateTime.fromISO(date)
    if (!parsed.isValid) return date
    const now = DateTime.local()
    if (parsed.hasSame(now, "day")) return language.t("home.sessions.group.today")
    if (parsed.hasSame(now.minus({ days: 1 }), "day")) return language.t("home.sessions.group.yesterday")
    return parsed.toFormat(parsed.year === now.year ? "M月d日" : "yyyy年M月d日")
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
      <div class={`flex-[1_1_auto] min-h-0 overflow-y-auto no-scrollbar ${props.bodyClass ?? "px-5 pb-6"}`}>
        <Show
          when={!summaries.loading && (summaries()?.length ?? 0) > 0}
          fallback={
            <div class="text-[13px] leading-5 text-v2-text-text-faint">{language.t("sidebar.dailySummary.empty")}</div>
          }
        >
          <div class="flex flex-col">
            <For each={summaries()}>
              {(s) => (
                <button
                  type="button"
                  class="relative block w-full border-l border-v2-border-border-muted pl-4 pb-5 text-left last:pb-0"
                  onClick={() => navigate("/daily")}
                >
                  <span
                    aria-hidden="true"
                    class="absolute -left-[5px] top-1 size-2 rounded-full bg-v2-background-bg-layer-04 ring-2 ring-v2-background-bg-base"
                  />
                  <div class="text-[12px] font-medium leading-4 text-v2-text-text-muted">{label(s.date)}</div>
                  <div class="text-[11px] leading-4 text-v2-text-text-faint">
                    {DateTime.fromISO(s.date).isValid ? DateTime.fromISO(s.date).toFormat("yyyy-MM-dd") : s.date}
                  </div>
                  <p class="mt-1 line-clamp-3 whitespace-pre-line text-[13px] leading-5 text-v2-text-text-base">
                    {s.overview}
                  </p>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

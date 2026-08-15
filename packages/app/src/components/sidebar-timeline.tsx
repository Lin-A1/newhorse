import { createResource, For, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"

/**
 * Daily summary timeline: renders the date + content list produced by the
 * newhorse `daily-summary` tool (auto-generated each day, no manual trigger).
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
  const [summaries] = createResource(async () => {
    const res = await serverSDK().client.dailySummary.list()
    return res.data ?? []
  })
  const showHeader = props.showHeader ?? true

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
                <div class="border-l border-v2-border-border-muted pl-4 pb-5">
                  <div class="text-[12px] font-medium leading-4 text-v2-text-text-muted">{s.date}</div>
                  <p class="mt-1 whitespace-pre-line text-[13px] leading-5 text-v2-text-text-base">{s.content}</p>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

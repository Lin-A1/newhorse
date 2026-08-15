import { createResource, createSignal, For, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { ButtonV2 } from "@newhorse/ui/v2/button-v2"
import { LoaderV2 } from "@newhorse/ui/v2/loader-v2"
import { showToast } from "@/utils/toast"

export function SidebarTimeline() {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const [summaries, { refetch }] = createResource(async () => {
    const res = await serverSDK().client.dailySummary.list()
    return res.data ?? []
  })
  const [generating, setGenerating] = createSignal(false)

  async function generate() {
    if (generating()) return
    setGenerating(true)
    try {
      const res = await serverSDK().client.dailySummary.generate({})
      await refetch()
      if (res.data) {
        showToast({ variant: "success", title: language.t("sidebar.dailySummary.generate.success") })
      } else {
        showToast({ title: language.t("sidebar.dailySummary.generate.noActivity") })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showToast({
        variant: "error",
        title: language.t("sidebar.dailySummary.generate.failed"),
        description: message,
      })
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div class="flex h-full min-w-0 flex-col overflow-hidden">
      <div class="flex items-center justify-between gap-2 px-5 pt-5 pb-3">
        <h2 class="text-[15px] font-medium tracking-[-0.13px] text-v2-text-text-strong">
          {language.t("sidebar.dailySummary")}
        </h2>
        <ButtonV2
          type="button"
          size="small"
          variant={generating() ? "loading" : "ghost-muted"}
          disabled={generating()}
          onClick={generate}
          aria-label={language.t("sidebar.dailySummary.generate")}
        >
          <Show when={generating()} fallback={language.t("sidebar.dailySummary.generate")}>
            <LoaderV2 />
          </Show>
        </ButtonV2>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-5 pb-6 no-scrollbar">
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

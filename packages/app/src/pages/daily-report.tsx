import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { DateTime } from "luxon"
import { useNavigate } from "@solidjs/router"
import { ButtonV2 } from "@newhorse/ui/v2/button-v2"
import { Icon as IconV2 } from "@newhorse/ui/v2/icon"
import { Spinner } from "@newhorse/ui/spinner"
import { ScrollView } from "@newhorse/ui/scroll-view"
import { Markdown } from "@newhorse/session-ui/markdown"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import type { DailyReport } from "@newhorse/sdk/v2"

const num = (value: number | string): number => Number(value)

const todoStatusKey = (
  status: string,
): "dailyReport.todo.pending" | "dailyReport.todo.in_progress" | "dailyReport.todo.completed" | "dailyReport.todo.cancelled" => {
  switch (status) {
    case "in_progress":
      return "dailyReport.todo.in_progress"
    case "completed":
      return "dailyReport.todo.completed"
    case "cancelled":
      return "dailyReport.todo.cancelled"
    default:
      return "dailyReport.todo.pending"
  }
}

function SectionCard(props: { title: string; children?: JSX.Element }) {
  return (
    <section class="flex flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
      <h2 class="text-[13px] font-medium tracking-[-0.04px] text-v2-text-text-muted">{props.title}</h2>
      {props.children}
    </section>
  )
}

export default function DailyReportPage() {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const navigate = useNavigate()

  const [selected, setSelected] = createSignal<string>(DateTime.local().toFormat("yyyy-MM-dd"))
  const [regenerating, setRegenerating] = createSignal(false)

  const [reports, { refetch }] = createResource(async () => {
    const res = await serverSDK().client.dailySummary.list()
    return res.data ?? []
  })

  const report = createMemo<DailyReport | undefined>(() => {
    return reports()?.find((item) => item.date === selected())
  })

  const regenerate = async () => {
    setRegenerating(true)
    try {
      const date = DateTime.fromISO(selected()).toJSDate().getTime()
      const res = await serverSDK().client.dailySummary.generate({ date })
      if (res.data == null) {
        showToast({ variant: "error", title: language.t("dailyReport.noActivity") })
        return
      }
      // The backend returns 200 with the fallback overview when the LLM path
      // failed; surface the embedded reason so the user can act on it instead
      // of silently re-seeing the generic fallback text.
      const fallback = res.data.overview.match(/LLM 暂不可用(?:：([^，\n]+))?/)
      if (fallback) {
        await refetch()
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: fallback[1],
        })
        return
      }
      await refetch()
      showToast({ variant: "success", title: language.t("dailyReport.regenerated") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setRegenerating(false)
    }
  }

  const dayLabel = (date: string) => {
    const parsed = DateTime.fromISO(date)
    if (!parsed.isValid) return date
    const now = DateTime.local()
    if (parsed.hasSame(now, "day")) return language.t("home.sessions.group.today")
    if (parsed.hasSame(now.minus({ days: 1 }), "day")) return language.t("home.sessions.group.yesterday")
    return parsed.toFormat(parsed.year === now.year ? "M月d日" : "yyyy年M月d日")
  }

  return (
    <div class="m-2 min-h-0 self-stretch flex-1 overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <ScrollView class="h-full [container-type:size]">
        <div class="mx-auto flex min-h-full w-full max-w-[720px] flex-col gap-4 px-4 py-6">
          <header class="flex items-center justify-between gap-3">
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
                {language.t("dailyReport.title")}
              </h1>
            </div>
            <ButtonV2
              size="small"
              variant="ghost-muted"
              disabled={regenerating()}
              onClick={() => void regenerate()}
            >
              <Show when={regenerating()} fallback={language.t("dailyReport.regenerate")}>
                <Spinner class="size-3.5" />
              </Show>
            </ButtonV2>
          </header>

          <div class="flex flex-wrap gap-1.5">
            <For each={(reports() ?? []).map((item) => item.date)}>
              {(date) => (
                <button
                  type="button"
                  class="rounded-[6px] px-2.5 py-1 text-[12px] leading-4 transition-colors"
                  classList={{
                    "bg-v2-background-bg-layer-03 text-v2-text-text-base": date === selected(),
                    "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover": date !== selected(),
                  }}
                  onClick={() => setSelected(date)}
                >
                  {dayLabel(date)}
                </button>
              )}
            </For>
          </div>

          <Show
            when={report()}
            fallback={
              <div class="py-10 text-center text-[13px] leading-5 text-v2-text-text-faint">
                {language.t("dailyReport.empty")}
              </div>
            }
          >
            {(r) => (
              <div class="flex flex-col gap-4">
                <SectionCard title={language.t("dailyReport.overview")}>
                  <Show when={r().overview.trim()} fallback={<p class="text-v2-text-text-faint">{language.t("dailyReport.noSessions")}</p>}>
                    <Markdown text={r().overview} class="text-[14px] leading-6 text-v2-text-text-base" />
                  </Show>
                </SectionCard>

                <Show when={r().work.length > 0}>
                  <SectionCard title={language.t("dailyReport.work")}>
                    <For each={r().work}>
                      {(section) => (
                        <div class="flex flex-col gap-1.5">
                          <Markdown text={section.body} class="text-[13px] leading-5 text-v2-text-text-base" />
                        </div>
                      )}
                    </For>
                  </SectionCard>
                </Show>

                <Show when={r().sessions.length > 0}>
                  <SectionCard title={language.t("dailyReport.sessions")}>
                    <div class="flex flex-col gap-3">
                      <For each={r().sessions}>
                        {(s) => (
                          <div class="flex flex-col gap-1.5 border-l border-v2-border-border-muted pl-3">
                            <div class="flex items-center justify-between gap-2">
                              <span class="text-[13px] font-medium text-v2-text-text-base">{s.title}</span>
                              <span class="text-[11px] text-v2-text-text-faint">
                                {s.source === "companion" ? "newhorse" : "work"}
                                {s.model ? ` · ${s.model}` : ""}
                              </span>
                            </div>
                            <Show when={num(s.filesChanged) > 0}>
                              <span class="text-[12px] text-v2-text-text-muted">
                                {language.t("dailyReport.session.filesChanged", { count: num(s.filesChanged) })}
                                {" · +"}
                                {num(s.additions)}
                                {" −"}
                                {num(s.deletions)}
                              </span>
                            </Show>
                            <Show when={s.todos.length > 0}>
                              <div class="flex flex-col gap-0.5">
                                <For each={s.todos}>
                                  {(todo) => (
                                    <span class="text-[12px] text-v2-text-text-muted">
                                      {todo.content}
                                      <span class="text-v2-text-text-faint"> · {language.t(todoStatusKey(todo.status))}</span>
                                    </span>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </SectionCard>
                </Show>

                <Show when={num(r().usage.sessions) > 0}>
                  <SectionCard title={language.t("dailyReport.usage")}>
                    <div class="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-v2-text-text-base">
                      <span>
                        {language.t("dailyReport.usage.sessions")}: {num(r().usage.sessions)}
                      </span>
                      <span>
                        {language.t("dailyReport.usage.tokens")}:{" "}
                        {num(r().usage.tokens.input) + num(r().usage.tokens.output) + num(r().usage.tokens.reasoning)}
                      </span>
                      <span>
                        {language.t("dailyReport.usage.cost")}: ${Number(r().usage.cost).toFixed(4)}
                      </span>
                      <Show when={r().usage.models.length > 0}>
                        <span class="text-v2-text-text-muted">
                          {language.t("dailyReport.usage.models")}: {r().usage.models.join(", ")}
                        </span>
                      </Show>
                    </div>
                  </SectionCard>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}

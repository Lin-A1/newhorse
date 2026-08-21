import { For, Show, createResource, onCleanup, onMount } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { listAllSessions } from "@/components/settings-usage"

const DAYS = 90
const CELL = 12
const GAP = 3

export type DayCell = {
  key: string
  label: string
  tokens: number
  level: 0 | 1 | 2 | 3 | 4
}

export function sessionTokenTotal(session: {
  tokens?: { input: number; output: number; reasoning: number; cache?: { read: number; write: number } }
}): number {
  const tokens = session.tokens
  if (!tokens) return 0
  // Activity = newly produced tokens only. Cache reads are passive reuse of an
  // already-billed prefix (they can reach tens of thousands of tokens per turn
  // for long sessions) and would drown out real work in the heatmap.
  return tokens.input + tokens.output + tokens.reasoning
}

export function sessionActivityTimestamp(session: { time?: { created?: number; updated?: number } }): number | undefined {
  return session.time?.updated ?? session.time?.created
}

// Level from the percentile rank so one unusually large day does not flatten
// every other active day into the faintest bucket.
function levelFor(value: number, active: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || active.length === 0) return 0
  const atOrBelow = active.filter((v) => v <= value).length
  const fraction = atOrBelow / active.length
  if (fraction <= 0.25) return 1
  if (fraction <= 0.5) return 2
  if (fraction <= 0.75) return 3
  return 4
}

/** Align day cells into complete Sunday-to-Saturday columns. */
export function buildContributionWeeks(cells: DayCell[], offset: number): Array<Array<DayCell | null>> {
  const padded: Array<DayCell | null> = [...Array(offset).fill(null), ...cells]
  while (padded.length % 7 !== 0) padded.push(null)
  const weeks: Array<Array<DayCell | null>> = []
  for (let index = 0; index < padded.length; index += 7) {
    const week = padded.slice(index, index + 7)
    if (week.some((cell) => cell !== null)) weeks.push(week)
  }
  return weeks
}

export function ContributionHeatmap() {
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const [cells, { refetch }] = createResource(async (): Promise<DayCell[]> => {
    const sessions = await listAllSessions(serverSDK)
    const byDayTokens = new Map<string, number>()
    const byDayCount = new Map<string, number>()
    for (const session of sessions) {
      const activity = sessionActivityTimestamp(session)
      if (!activity) continue
      const date = new Date(activity)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      byDayTokens.set(key, (byDayTokens.get(key) ?? 0) + sessionTokenTotal(session))
      byDayCount.set(key, (byDayCount.get(key) ?? 0) + 1)
    }
    // Prefer token volume, but if sessions report no tokens at all fall back to
    // session count so the chart still reflects activity instead of going blank.
    const anyTokens = [...byDayTokens.values()].some((value) => value > 0)
    const valueFor = (key: string) => (anyTokens ? byDayTokens.get(key) ?? 0 : byDayCount.get(key) ?? 0)
    const active = [...byDayTokens.keys(), ...byDayCount.keys()]
      .map(valueFor)
      .filter((value) => value > 0)
      .sort((a, b) => a - b)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return Array.from({ length: DAYS }, (_, index) => {
      const date = new Date(today.getTime() - (DAYS - 1 - index) * 86_400_000)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      const value = valueFor(key)
      return {
        key,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        tokens: byDayTokens.get(key) ?? 0,
        level: levelFor(value, active),
      }
    })
  })

  onMount(() => {
    const refresh = () => {
      if (cells.loading) return
      void Promise.resolve(refetch()).catch(() => {})
    }
    const timer = setInterval(refresh, 60_000)
    window.addEventListener("focus", refresh)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
    })
  })

  const weeks = () => {
    const data = cells()
    if (!data?.length) return []
    const first = new Date()
    first.setHours(0, 0, 0, 0)
    first.setDate(first.getDate() - (DAYS - 1))
    return buildContributionWeeks(data, first.getDay())
  }

  const monthLabels = () => {
    const labels: Array<{ text: string; col: number }> = []
    let previousMonth = -1
    weeks().forEach((week, index) => {
      const first = week.find((cell): cell is DayCell => cell !== null)
      if (!first) return
      const month = Number(first.key.slice(5, 7))
      if (month === previousMonth) return
      labels.push({ text: `${month}月`, col: index })
      previousMonth = month
    })
    return labels
  }

  const levelClass = [
    "bg-[#ebedf0] dark:bg-[#21262d]",
    "bg-[#9be9a8] dark:bg-[#0e4429]",
    "bg-[#40c463] dark:bg-[#006d32]",
    "bg-[#30a14e] dark:bg-[#26a641]",
    "bg-[#216e39] dark:bg-[#39d353]",
  ]

  return (
    <div class="flex min-w-0 flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium text-v2-text-text-muted">{language.t("workbench.activity")}</span>
        <span class="text-[10px] text-v2-text-text-faint">90 {language.t("workbench.days")}</span>
      </div>
      <Show
        when={!cells.loading && weeks().length > 0}
        fallback={
          <div class="flex h-[120px] items-center justify-center text-[11px] text-v2-text-text-faint">
            {cells.loading ? language.t("common.loading") : cells.error ? language.t("workbench.activity.error") : language.t("workbench.activity.empty")}
          </div>
        }
      >
        <div class="overflow-x-auto pb-1 no-scrollbar">
          <div class="flex w-full max-w-[560px] flex-col gap-[3px] mx-auto">
            <div class="flex gap-[3px] justify-center">
              <div class="shrink-0" style={{ width: "22px" }} />
              <div class="grid gap-[3px]" style={{ "grid-template-columns": `repeat(${weeks().length}, clamp(10px, 1.4vw, 14px))` }}>
                <For each={monthLabels()}>
                  {(month) => (
                    <div class="text-[9px] leading-[10px] text-v2-text-text-faint" style={{ "grid-column": month.col + 1 }}>
                      {month.text}
                    </div>
                  )}
                </For>
              </div>
            </div>
            <div class="flex gap-[3px] justify-center">
              <div class="flex shrink-0 flex-col gap-[3px]" style={{ width: "22px" }}>
                <For each={[0, 1, 2, 3, 4, 5, 6]}>
                  {(row) => (
                    <div class="flex items-center text-[9px] leading-[12px] text-v2-text-text-faint" style={{ height: "clamp(10px, 1.4vw, 14px)" }}>
                      {row === 1 ? language.t("workbench.weekday.mon") : row === 3 ? language.t("workbench.weekday.wed") : row === 5 ? language.t("workbench.weekday.fri") : ""}
                    </div>
                  )}
                </For>
              </div>
              <For each={weeks()}>
                {(week) => (
                  <div class="flex flex-col gap-[3px]">
                    <For each={week}>
                      {(cell) => (
                        <div
                          title={cell ? `${cell.label}: ${cell.tokens.toLocaleString(language.intl())}` : undefined}
                          class={`rounded-[2px] ${levelClass[cell ? cell.level : 0]}`}
                          style={{ width: "clamp(10px, 1.4vw, 14px)", height: "clamp(10px, 1.4vw, 14px)" }}
                        />
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
            <div class="flex items-center justify-end gap-1 pt-0.5">
              <span class="text-[9px] text-v2-text-text-faint">{language.t("workbench.less")}</span>
              <For each={levelClass}>{(className) => <div class={`h-[9px] w-[9px] rounded-[2px] ${className}`} />}</For>
              <span class="text-[9px] text-v2-text-text-faint">{language.t("workbench.more")}</span>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

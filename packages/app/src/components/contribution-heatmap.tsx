import { createResource, For, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { listAllSessions } from "@/components/settings-usage"

/**
 * GitHub-style contribution heatmap: one column per week, one cell per day,
 * colored by that day's total tokens. Five levels (none/low/medium/high/peak)
 * bucketed from the 90-day token distribution. Clicking a day navigates to
 * the daily report.
 */
const DAYS = 90

type DayCell = {
  key: string
  label: string
  tokens: number
  level: 0 | 1 | 2 | 3 | 4
}

function levelFor(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0) return 0
  const ratio = max > 0 ? tokens / max : 0
  if (ratio <= 0.1) return 1
  if (ratio <= 0.35) return 2
  if (ratio <= 0.7) return 3
  return 4
}

export function ContributionHeatmap() {
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const [cells] = createResource(async (): Promise<DayCell[]> => {
    const sessions = await listAllSessions(serverSDK)
    // Bucket tokens by local calendar day (yyyy-MM-dd).
    const byDay = new Map<string, number>()
    for (const session of sessions) {
      const created = session.time?.created
      if (!created) continue
      const tokens = session.tokens ? session.tokens.input + session.tokens.output : 0
      if (tokens <= 0) continue
      const d = new Date(created)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      byDay.set(key, (byDay.get(key) ?? 0) + tokens)
    }

    // Build the last 90 days ending today (today on the right).
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const out: DayCell[] = []
    let max = 0
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      const tokens = byDay.get(key) ?? 0
      if (tokens > max) max = tokens
      out.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, tokens, level: 0 })
    }
    for (const cell of out) cell.level = levelFor(cell.tokens, max)
    return out
  })

  // Layout: grid with one row per weekday (Sun..Sat), one column per week.
  const weeks: DayCell[][] = []
  const cellsData = cells()
  if (cellsData && cellsData.length > 0) {
    // First day's weekday offset so columns align to weeks.
    const first = new Date()
    first.setHours(0, 0, 0, 0)
    first.setDate(first.getDate() - (DAYS - 1))
    const offset = first.getDay() // 0=Sun
    const padded: (DayCell | null)[] = [...Array(offset).fill(null), ...cellsData]
    while (padded.length % 7 !== 0) padded.push(null)
    for (let i = 0; i < padded.length; i += 7) {
      const col = padded.slice(i, i + 7)
      const nonNull = col.some((c) => c !== null)
      if (nonNull) weeks.push(col as DayCell[])
    }
  }

  const monthLabels = () => {
    if (!cellsData || cellsData.length === 0) return []
    const labels: { text: string; col: number }[] = []
    let prevMonth = -1
    weeks.forEach((week, wi) => {
      const first = week.find((c) => c !== null)
      if (!first) return
      const m = Number(first.key.slice(5, 7))
      if (m !== prevMonth) {
        labels.push({ text: `${m}月`, col: wi })
        prevMonth = m
      }
    })
    return labels
  }

  const LEVEL_CLASS = [
    "bg-v2-background-bg-layer-02",
    "bg-v2-accent-accent/15",
    "bg-v2-accent-accent/35",
    "bg-v2-accent-accent/60",
    "bg-v2-accent-accent",
  ]

  return (
    <div class="flex min-w-0 flex-col gap-1.5">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium text-v2-text-text-muted">{language.t("workbench.activity")}</span>
        <span class="text-[10px] text-v2-text-text-faint">90 {language.t("workbench.days")}</span>
      </div>

      <Show
        when={!cells.loading && weeks.length > 0}
        fallback={
          <div class="flex h-16 items-center justify-center text-[11px] text-v2-text-text-faint">
            {language.t("sidebar.dailySummary.empty")}
          </div>
        }
      >
        {/* Month labels */}
        <div class="flex gap-[3px] pl-5">
          <For each={monthLabels()}>
            {(m) => (
              <div class="w-[10px] text-[9px] leading-3 text-v2-text-text-faint" style={{ "margin-left": m.col > 0 ? `${(m.col - 1) * 13}px` : undefined }}>
                {m.text}
              </div>
            )}
          </For>
        </div>

        <div class="flex gap-[3px]">
          <For each={weeks}>
            {(week) => (
              <div class="flex w-[10px] flex-col gap-[3px]">
                <For each={week}>
                  {(cell) => (
                    <Show
                      when={cell !== null}
                      fallback={<div class="h-[10px] w-[10px]" />}
                    >
                      <div
                        title={`${cell!.label}: ${cell!.tokens.toLocaleString(language.intl())}`}
                        class={`h-[10px] w-[10px] rounded-[2px] ${LEVEL_CLASS[cell!.level]}`}
                      />
                    </Show>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>

        {/* Legend */}
        <div class="flex items-center justify-end gap-1 pt-0.5">
          <span class="text-[9px] text-v2-text-text-faint">{language.t("workbench.less")}</span>
          <For each={LEVEL_CLASS}>
            {(cls) => <div class={`h-[8px] w-[8px] rounded-[2px] ${cls}`} />}
          </For>
          <span class="text-[9px] text-v2-text-text-faint">{language.t("workbench.more")}</span>
        </div>
      </Show>
    </div>
  )
}

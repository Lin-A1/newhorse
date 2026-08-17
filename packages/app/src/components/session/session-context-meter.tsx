import { For, Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionProjection } from "./session-projection"
import type { SessionProjected } from "@newhorse/sdk/v2/client"

const BREAKDOWN_COLOR = {
  system: "var(--syntax-info)",
  tools: "var(--syntax-warning)",
  messages: "var(--syntax-property)",
} as const

type BreakdownKey = keyof typeof BREAKDOWN_COLOR

const breakdownSegments = (projected: SessionProjected | undefined) => {
  const breakdown = projected?.contextBreakdown
  if (!breakdown) return []
  return (["system", "tools", "messages"] as const).flatMap((key) => {
    const tokens = breakdown[key]
    if (tokens <= 0) return []
    return [{ key, tokens }]
  })
}

export function SessionContextMeter(props: {
  sessionID: () => string | undefined
  locale: string
  compact?: boolean
}) {
  const language = useLanguage()
  const sync = useSync()
  const { data } = useSessionProjection(props.sessionID)

  const info = createMemo(() => {
    const id = props.sessionID()
    if (!id) return undefined
    return sync().session.get(id)
  })
  const projected = data
  const pressure = () => projected()?.contextPressure.pressure ?? 0
  const window = () => projected()?.contextPressure.window ?? 0
  const projectedPressure = () => projected()?.contextPressure.projected ?? 0
  const segments = () => breakdownSegments(projected())
  const total = () => segments().reduce((sum, segment) => sum + segment.tokens, 0)

  const number = (value: number | undefined) => {
    if (value === undefined) return "—"
    return value.toLocaleString(props.locale)
  }
  const percent = (value: number) => value.toLocaleString(props.locale) + "%"

  const breakdownLabel = (key: BreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "tools") return language.t("context.breakdown.tool")
    return language.t("context.stats.messages")
  }

  return (
    <div class="flex w-full flex-col gap-2">
      <div class="relative h-2 w-full rounded-full bg-surface-base overflow-hidden">
        <div class="absolute inset-y-0 left-0 flex overflow-hidden rounded-full">
          <For each={segments()}>
            {(segment) => (
              <div
                class="h-full"
                style={{
                  width: `${total() > 0 ? (segment.tokens / total()) * Math.min(pressure(), 100) : 0}%`,
                  "background-color": BREAKDOWN_COLOR[segment.key as BreakdownKey],
                }}
              />
            )}
          </For>
        </div>
        <Show when={window() > 0 && projectedPressure() > 0}>
          {/* Projected next-turn footprint: a thin dashed tick so the bar reads
              as the CURRENT usage, with the projection as a secondary hint. */}
          <div
            class="absolute inset-y-0 w-px border-l border-dashed border-text-interactive-base/50"
            style={{ left: `${Math.min(projectedPressure(), 100)}%` }}
            title={`${language.t("context.meter.projected")}: ${percent(projectedPressure())}`}
          />
        </Show>
      </div>
      <Show when={!props.compact}>
        <div class="flex flex-wrap gap-x-3 gap-y-1">
          <div class="flex items-center gap-1 text-11-regular text-text-weak">
            <span class="text-text-base">{percent(pressure())}</span>
            <span>{language.t("context.meter.used")}</span>
            <span class="text-text-weaker">/ {number(window() || undefined)}</span>
          </div>
          <Show when={projectedPressure() > 0}>
            <div class="flex items-center gap-1 text-11-regular text-text-weak">
              <span class="text-text-base">{percent(projectedPressure())}</span>
              <span>{language.t("context.meter.projected")}</span>
            </div>
          </Show>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1">
          <For each={segments()}>
            {(segment) => (
              <div class="flex items-center gap-1 text-11-regular text-text-weak">
                <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key as BreakdownKey] }} />
                <div>{breakdownLabel(segment.key as BreakdownKey)}</div>
                <div class="text-text-weaker">{number(segment.tokens)}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
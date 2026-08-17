import { createMemo, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { TooltipV2 } from "@newhorse/ui/v2/tooltip-v2"
import { useSessionProjection, cacheHitRate } from "@/components/session/session-projection"
import { SessionContextMeter } from "@/components/session/session-context-meter"

export function SessionStatsRow(props: {
  trajectory: boolean
  onToggleTrajectory: (enabled: boolean) => void
}) {
  const sync = useSync()
  const language = useLanguage()
  const { params } = useSessionLayout()

  const sessionID = createMemo(() => params.id)
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    return sync().session.get(id)
  })
  const { data, pending } = useSessionProjection(sessionID)

  const hitRate = createMemo(() => cacheHitRate(info()))
  const pressure = () => data()?.contextPressure.pressure
  const projected = () => data()?.projectedTokens
  const number = (value: number | undefined) => (value === undefined ? "—" : value.toLocaleString(language.intl()))

  return (
    <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border-weak-base">
      <div class="flex items-center gap-2 text-11-regular text-text-weak">
        <span>{language.t("session.stats.cacheHit")}</span>
        <span class="text-12-medium text-text-strong">
          {hitRate() === undefined ? language.t("context.stats.na") : (hitRate()! * 100).toFixed(1) + "%"}
        </span>
      </div>

      <div class="h-3 w-px bg-border-weak-base" />

      <Show when={pending()}>
        <span class="text-11-regular text-text-weaker">{language.t("common.loading")}</span>
      </Show>
      <Show when={!pending()}>
        <TooltipV2
          value={
            <div class="w-[220px]">
              <SessionContextMeter sessionID={sessionID} locale={language.intl()} />
            </div>
          }
          placement="bottom"
          shift={-8}
        >
          <div class="flex items-center gap-2 text-11-regular text-text-weak">
            <span>{language.t("session.stats.context")}</span>
            <span class="text-12-medium text-text-strong">
              {pressure() === undefined ? language.t("context.stats.na") : pressure()! + "%"}
            </span>
            <Show when={projected() && projected()!.nextCost > 0}>
              <span class="text-text-weaker">≈ ${projected()!.nextCost.toFixed(4)}</span>
            </Show>
          </div>
        </TooltipV2>
      </Show>

      <div class="flex-1" />

      <div class="flex items-center gap-1 rounded-md bg-surface-subtle p-0.5">
        <button
          type="button"
          class="rounded px-2 py-0.5 text-11-regular transition-colors"
          classList={{
            "bg-surface-raised-base text-text-strong shadow-sm": !props.trajectory,
            "text-text-weak hover:text-text-base": props.trajectory,
          }}
          onClick={() => props.onToggleTrajectory(false)}
        >
          {language.t("session.stats.view.messages")}
        </button>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-11-regular transition-colors"
          classList={{
            "bg-surface-raised-base text-text-strong shadow-sm": props.trajectory,
            "text-text-weak hover:text-text-base": !props.trajectory,
          }}
          onClick={() => props.onToggleTrajectory(true)}
        >
          {language.t("session.stats.view.trajectory")}
        </button>
      </div>
    </div>
  )
}
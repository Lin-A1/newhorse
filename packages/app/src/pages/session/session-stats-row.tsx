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

  return (
    <div class="flex items-center gap-3 px-3 py-1.5 border-b border-border-weak-base">
      {/* Cache hit + Context metrics, left of the context meter bar */}
      <div class="flex items-center gap-3 text-11-regular text-text-weak">
        <span>{language.t("session.stats.cacheHit")}</span>
        <span class="text-12-medium text-text-strong">
          {hitRate() === undefined ? language.t("context.stats.na") : (hitRate()! * 100).toFixed(1) + "%"}
        </span>
        <span class="text-text-faint">·</span>
        <span>{language.t("session.stats.context")}</span>
        <span class="text-12-medium text-text-strong">
          {pressure() === undefined ? language.t("context.stats.na") : pressure()! + "%"}
        </span>
      </div>

      {/* Context meter bar with a detail tooltip */}
      <TooltipV2
        value={
          <div class="w-[220px]">
            <SessionContextMeter sessionID={sessionID} locale={language.intl()} />
          </div>
        }
        placement="bottom"
        shift={-8}
      >
        <div class="w-28 shrink-0">
          <Show when={pending()} fallback={<SessionContextMeter sessionID={sessionID} locale={language.intl()} compact />}>
            <span class="text-11-regular text-text-weaker">{language.t("common.loading")}</span>
          </Show>
        </div>
      </TooltipV2>

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

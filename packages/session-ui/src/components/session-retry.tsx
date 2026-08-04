import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { SessionStatus } from "@newhorse/sdk/v2/client"
import { useI18n } from "@newhorse/ui/context/i18n"
import { Card } from "@newhorse/ui/card"
import { Tooltip } from "@newhorse/ui/tooltip"
import { Spinner } from "@newhorse/ui/spinner"

export function SessionRetry(props: { status: SessionStatus; show?: boolean }) {
  const i18n = useI18n()
  const retry = createMemo(() => {
    if (props.status.type !== "retry") return
    return props.status
  })
  const [seconds, setSeconds] = createSignal(0)
  createEffect(
    on(retry, (current) => {
      if (!current) return
      const update = () => {
        const next = retry()?.next
        if (!next) return
        setSeconds(Math.round((next - Date.now()) / 1000))
      }
      update()
      const timer = setInterval(update, 1000)
      onCleanup(() => clearInterval(timer))
    }),
  )
  const message = createMemo(() => {
    const current = retry()
    if (!current) return ""
    if (current.message.includes("exceeded your current quota") && current.message.includes("gemini")) {
      return i18n.t("ui.sessionTurn.retry.geminiHot")
    }
    if (current.message.length > 80) return current.message.slice(0, 80) + "..."
    return current.message
  })
  const truncated = createMemo(() => {
    const current = retry()
    if (!current) return false
    return current.message.length > 80
  })
  const info = createMemo(() => {
    const current = retry()
    if (!current) return ""
    const count = Math.max(0, seconds())
    const delay = count > 0 ? i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: count }) : ""
    const retrying = i18n.t("ui.sessionTurn.retry.retrying")
    const line = [retrying, delay].filter(Boolean).join(" ")
    if (!line) return i18n.t("ui.sessionTurn.retry.attempt", { attempt: current.attempt })
    return i18n.t("ui.sessionTurn.retry.attemptLine", { line, attempt: current.attempt })
  })
  const action = createMemo(() => retry()?.action)

  return (
    <Show when={retry() && (props.show ?? true)}>
      <div data-slot="session-turn-retry">
        <Card variant="error" class="error-card">
          <div class="flex items-start gap-2">
            <Spinner class="size-4 mt-0.5" />
            <div class="min-w-0">
              <Show when={truncated()} fallback={<div data-slot="session-turn-retry-message">{message()}</div>}>
                <Tooltip value={retry()?.message ?? ""} placement="top">
                  <div data-slot="session-turn-retry-message" class="cursor-help truncate">
                    {message()}
                  </div>
                </Tooltip>
              </Show>
              <Show when={info()}>{(line) => <div data-slot="session-turn-retry-info">{line()}</div>}</Show>
              <Show when={action()}>
                {(act) => (
                  <div class="mt-1 flex flex-wrap items-center gap-1.5 text-12-regular">
                    <span>{act().message}</span>
                    <Show
                      when={act().link}
                      fallback={<span class="font-medium text-error">{act().label}</span>}
                    >
                      <a class="font-medium underline" href={act().link} target="_blank" rel="noreferrer">
                        {act().label}
                      </a>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Card>
      </div>
    </Show>
  )
}

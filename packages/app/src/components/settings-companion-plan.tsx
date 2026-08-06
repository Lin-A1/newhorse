import { For, Show } from "solid-js"
import { Button } from "@newhorse/ui/button"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { effectiveContinuityStatus } from "./settings-continuity-grants-state"
import { useCompanionPlanReviewState } from "./settings-companion-plan-state"
import { formatNominalTime, recurrenceSummary } from "./settings-reminders-helpers"
import { memoryKindLabel, memoryScopeLabel } from "./settings-memory"
import { reminderStatusLabel } from "./settings-reminders"
import { useConfirm } from "./confirm-dialog"

export function SettingsCompanionPlan(props: { sessionID?: string }) {
  const language = useLanguage()
  const plan = useCompanionPlanReviewState(props.sessionID)
  const confirm = useConfirm()
  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.companionPlan.title"),
      description: formatServerError(error, undefined, language.t("common.requestFailed")),
    })
  const refresh = () => void plan.refreshAll().catch(fail)

  return (
    <div class="flex min-h-0 min-w-0 flex-col px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-6 py-8">
        <section class="flex flex-col gap-2">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.companionPlan.title")}</h2>
          <p class="text-12-regular text-text-weak">{language.t("settings.companionPlan.description")}</p>
          <div class="rounded-lg border border-border-weak-base bg-surface-subtle-base p-3 text-12-regular text-text-weak">
            {language.t("settings.companionPlan.disclaimer")}
          </div>
          <Button size="small" onClick={refresh} disabled={plan.loading()}>
            {language.t("settings.companionPlan.refresh")}
          </Button>
        </section>

        <section class="flex flex-col gap-3" data-companion-plan-section="memory">
          <h3 class="text-16-medium text-text-strong">{language.t("settings.companionPlan.memory.title")}</h3>
          <Show
            when={!plan.memory.ready.error}
            fallback={
              <div class="flex items-center gap-3 text-12-regular text-text-weak">
                <span>{language.t("settings.companionPlan.memory.unavailable")}</span>
                <Button size="small" onClick={refresh}>
                  {language.t("common.retry")}
                </Button>
              </div>
            }
          >
            <Show when={!plan.memory.loading()} fallback={<div class="text-12-regular text-text-weak">{language.t("settings.companionPlan.loading")}</div>}>
              <Show
                when={plan.memoryProposals().length > 0}
                fallback={<p class="text-12-regular text-text-weak">{language.t("settings.companionPlan.memory.empty")}</p>}
              >
                <For each={plan.memoryProposals()}>
                  {(item) => (
                    <article
                      class="flex flex-col gap-3 rounded-lg bg-surface-base p-4"
                      data-companion-plan-memory-id={item.id}
                    >
                      <p class="whitespace-pre-wrap text-14-regular text-text-base">{item.content}</p>
                      <p class="text-11-regular text-text-weak">{memoryKindLabel(language.t, item.kind)} · {memoryScopeLabel(language.t, item.scope)}</p>
                      <div class="flex flex-wrap gap-2">
                        <Button
                          size="small"
                          disabled={!!plan.memory.state.mutating}
                          onClick={() => void plan.memory.decide(item, "accept").catch(fail)}
                        >
                          {language.t("common.accept")}
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={!!plan.memory.state.mutating}
                          onClick={() => void plan.memory.decide(item, "reject").catch(fail)}
                        >
                          {language.t("common.reject")}
                        </Button>
                      </div>
                    </article>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </section>

        <section class="flex flex-col gap-3" data-companion-plan-section="reminders">
          <h3 class="text-16-medium text-text-strong">{language.t("settings.companionPlan.reminders.title")}</h3>
          <Show
            when={!plan.reminders.error()}
            fallback={
              <div class="flex items-center gap-3 text-12-regular text-text-weak">
                <span>{language.t("settings.companionPlan.reminders.unavailable")}</span>
                <Button size="small" onClick={refresh}>
                  {language.t("common.retry")}
                </Button>
              </div>
            }
          >
            <Show when={!plan.reminders.loading()} fallback={<div class="text-12-regular text-text-weak">{language.t("settings.companionPlan.loading")}</div>}>
              <Show
                when={plan.activeReminders().length > 0}
                fallback={<p class="text-12-regular text-text-weak">{language.t("settings.companionPlan.reminders.empty")}</p>}
              >
                <For each={plan.activeReminders()}>
                  {(item) => (
                    <article
                      class="flex flex-col gap-3 rounded-lg bg-surface-base p-4"
                      data-companion-plan-reminder-id={item.id}
                    >
                      <div>
                        <h4 class="text-14-medium text-text-strong">{item.title}</h4>
                        <p class="whitespace-pre-wrap text-14-regular text-text-base">{item.body}</p>
                      </div>
                      <p class="text-11-regular text-text-weak">
                        {reminderStatusLabel(language.t, item.status)} · {formatNominalTime(item.scheduleAt, item.timezone)} ·{" "}
                        {recurrenceSummary(language.t, item.recurrenceRule)}
                      </p>
                      <div class="flex flex-wrap gap-2">
                        <Button
                          size="small"
                          disabled={!!plan.reminders.state.mutating}
                          onClick={() => void plan.reminders.pause(item, item.status !== "paused").catch(fail)}
                        >
                          {item.status === "paused" ? language.t("common.resume") : language.t("common.pause")}
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={!!plan.reminders.state.mutating}
                          onClick={() => {
                            void (async () => {
                              const confirmed = await confirm({
                                title: language.t("common.cancel"),
                                message: language.t("settings.reminders.cancel.confirm"),
                              })
                              if (!confirmed) return
                              void plan.reminders.cancel(item).catch(fail)
                            })()
                          }}
                        >
                          {language.t("common.cancel")}
                        </Button>
                      </div>
                    </article>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </section>

        <section class="flex flex-col gap-3" data-companion-plan-section="continuity">
          <h3 class="text-16-medium text-text-strong">{language.t("settings.companionPlan.continuity.title")}</h3>
          <Show
            when={plan.continuity.available()}
            fallback={<p class="text-12-regular text-text-weak">{language.t("settings.companionPlan.continuity.unavailable")}</p>}
          >
            <Show
              when={!plan.continuity.ready.error}
              fallback={
                <div class="flex items-center gap-3 text-12-regular text-text-weak">
                  <span>{language.t("settings.companionPlan.continuity.unavailable")}</span>
                  <Button size="small" onClick={refresh}>
                    {language.t("common.retry")}
                  </Button>
                </div>
              }
            >
              <Show
                when={!plan.continuity.loading()}
                fallback={<div class="text-12-regular text-text-weak">{language.t("settings.companionPlan.loading")}</div>}
              >
                <Show
                  when={plan.continuityGrants().length > 0}
                  fallback={<p class="text-12-regular text-text-weak">{language.t("settings.companionPlan.continuity.empty")}</p>}
                >
                  <For each={plan.continuityGrants()}>
                    {(item) => {
                      const status = () => effectiveContinuityStatus(item)
                      return (
                        <article
                          class="flex flex-col gap-3 rounded-lg bg-surface-base p-4"
                          data-companion-plan-continuity-id={item.id}
                        >
                          <div>
                            <h4 class="text-14-medium text-text-strong">{item.purpose}</h4>
                            <p class="whitespace-pre-wrap text-14-regular text-text-base">{item.summary}</p>
                          </div>
                          <p class="text-11-regular text-text-weak">
                            {language.t(`settings.continuity.status.${status()}`)} · {language.t("settings.continuity.expires", { time: formatDate(item.timeExpires) })}
                          </p>
                          <div class="flex flex-wrap gap-2">
                            <Button
                              size="small"
                              disabled={!!plan.continuity.state.mutating || status() !== "proposed"}
                              onClick={() => {
                                void (async () => {
                                  const confirmed = await confirm({
                                    title: language.t("common.approve"),
                                    message: language.t("settings.companionPlan.approve.confirm"),
                                  })
                                  if (!confirmed) return
                                  void plan.continuity.approve(item).catch(fail)
                                })()
                              }}
                            >
                              {language.t("common.approve")}
                            </Button>
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={!!plan.continuity.state.mutating || status() === "revoked" || status() === "expired"}
                              onClick={() => {
                                void (async () => {
                                  const confirmed = await confirm({
                                    title: language.t("common.revoke"),
                                    message: language.t("settings.companionPlan.revoke.confirm"),
                                  })
                                  if (!confirmed) return
                                  void plan.continuity.revoke(item).catch(fail)
                                })()
                              }}
                            >
                              {language.t("common.revoke")}
                            </Button>
                          </div>
                        </article>
                      )
                    }}
                  </For>
                </Show>
              </Show>
            </Show>
          </Show>
        </section>
      </div>
    </div>
  )
}

function formatDate(value: number) {
  return new Date(value).toLocaleString()
}

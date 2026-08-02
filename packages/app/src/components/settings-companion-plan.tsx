import { For, Show } from "solid-js"
import { Button } from "@newhorse/ui/button"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import { effectiveContinuityStatus } from "./settings-continuity-grants-state"
import { useCompanionPlanReviewState } from "./settings-companion-plan-state"
import { formatNominalTime, recurrenceSummary } from "./settings-reminders-helpers"

export function SettingsCompanionPlan(props: { sessionID?: string }) {
  const plan = useCompanionPlanReviewState(props.sessionID)
  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: "Companion plan request failed",
      description: formatServerError(error, undefined, "Unknown Companion plan error"),
    })
  const refresh = () => void plan.refreshAll().catch(fail)

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-6 py-8">
        <section class="flex flex-col gap-2">
          <h2 class="text-16-medium text-text-strong">Companion Plan Review</h2>
          <p class="text-12-regular text-text-weak">
            Review proposed Memory, scheduled Reminders, and minimized Continuity grants in one place.
          </p>
          <div class="rounded-lg border border-border-weak-base bg-surface-subtle-base p-3 text-12-regular text-text-weak">
            Uses minimized continuity only. Does not read raw history. Does not automatically persist relationship Memory.
          </div>
          <Button size="small" onClick={refresh} disabled={plan.loading()}>
            Refresh plan
          </Button>
        </section>

        <section class="flex flex-col gap-3" data-companion-plan-section="memory">
          <h3 class="text-16-medium text-text-strong">Memory proposals</h3>
          <Show
            when={!plan.memory.ready.error}
            fallback={
              <div class="flex items-center gap-3 text-12-regular text-text-weak">
                <span>Memory proposals unavailable.</span>
                <Button size="small" onClick={refresh}>
                  Retry
                </Button>
              </div>
            }
          >
            <Show when={!plan.memory.loading()} fallback={<div class="text-12-regular text-text-weak">Loading plan…</div>}>
              <Show
                when={plan.memoryProposals().length > 0}
                fallback={<p class="text-12-regular text-text-weak">No proposed Memory.</p>}
              >
                <For each={plan.memoryProposals()}>
                  {(item) => (
                    <article
                      class="flex flex-col gap-3 rounded-lg bg-surface-base p-4"
                      data-companion-plan-memory-id={item.id}
                    >
                      <p class="whitespace-pre-wrap text-14-regular text-text-base">{item.content}</p>
                      <p class="text-11-regular text-text-weak">{item.kind} · {item.scope}</p>
                      <div class="flex flex-wrap gap-2">
                        <Button
                          size="small"
                          disabled={!!plan.memory.state.mutating}
                          onClick={() => void plan.memory.decide(item, "accept").catch(fail)}
                        >
                          Accept
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={!!plan.memory.state.mutating}
                          onClick={() => void plan.memory.decide(item, "reject").catch(fail)}
                        >
                          Reject
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
          <h3 class="text-16-medium text-text-strong">Reminders</h3>
          <Show
            when={!plan.reminders.error()}
            fallback={
              <div class="flex items-center gap-3 text-12-regular text-text-weak">
                <span>Reminders unavailable.</span>
                <Button size="small" onClick={refresh}>
                  Retry
                </Button>
              </div>
            }
          >
            <Show when={!plan.reminders.loading()} fallback={<div class="text-12-regular text-text-weak">Loading plan…</div>}>
              <Show
                when={plan.activeReminders().length > 0}
                fallback={<p class="text-12-regular text-text-weak">No active recurring Reminders.</p>}
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
                        {item.status} · {formatNominalTime(item.scheduleAt, item.timezone)} ·{" "}
                        {recurrenceSummary(item.recurrenceRule)}
                      </p>
                      <div class="flex flex-wrap gap-2">
                        <Button
                          size="small"
                          disabled={!!plan.reminders.state.mutating}
                          onClick={() => void plan.reminders.pause(item, item.status !== "paused").catch(fail)}
                        >
                          {item.status === "paused" ? "Resume" : "Pause"}
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={!!plan.reminders.state.mutating}
                          onClick={() => {
                            if (!window.confirm("Cancel this reminder? Future delivery or recurrence will stop.")) return
                            void plan.reminders.cancel(item).catch(fail)
                          }}
                        >
                          Cancel
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
          <h3 class="text-16-medium text-text-strong">Continuity grants</h3>
          <Show
            when={plan.continuity.available()}
            fallback={<p class="text-12-regular text-text-weak">Open settings from a source session to review grants.</p>}
          >
            <Show
              when={!plan.continuity.ready.error}
              fallback={
                <div class="flex items-center gap-3 text-12-regular text-text-weak">
                  <span>Continuity grants unavailable.</span>
                  <Button size="small" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              }
            >
              <Show
                when={!plan.continuity.loading()}
                fallback={<div class="text-12-regular text-text-weak">Loading plan…</div>}
              >
                <Show
                  when={plan.continuityGrants().length > 0}
                  fallback={<p class="text-12-regular text-text-weak">No Continuity grants for this source session.</p>}
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
                            {status()} · expires {new Date(item.timeExpires).toLocaleString()}
                          </p>
                          <div class="flex flex-wrap gap-2">
                            <Button
                              size="small"
                              disabled={!!plan.continuity.state.mutating || status() !== "proposed"}
                              onClick={() => {
                                if (
                                  !window.confirm("Approve this minimized handoff for the destination Companion session?")
                                )
                                  return
                                void plan.continuity.approve(item).catch(fail)
                              }}
                            >
                              Approve
                            </Button>
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={!!plan.continuity.state.mutating || status() === "revoked" || status() === "expired"}
                              onClick={() => {
                                if (!window.confirm("Revoke this continuity grant immediately?")) return
                                void plan.continuity.revoke(item).catch(fail)
                              }}
                            >
                              Revoke
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

import { Button } from "@newhorse/ui/button"
import { For, Show, createSignal } from "solid-js"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import {
  effectiveContinuityStatus,
  useContinuityGrantState,
  type ContinuityGrantInfo,
} from "./settings-continuity-grants-state"

export function SettingsContinuityGrants(props: { sessionID?: string }) {
  const grants = useContinuityGrantState(props.sessionID)
  const [expanded, setExpanded] = createSignal<string>()
  let auditRequest = 0

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: "Continuity request failed",
      description: formatServerError(error, undefined, "Unknown Continuity error"),
    })

  const audit = async (item: ContinuityGrantInfo) => {
    const request = ++auditRequest
    if (expanded() === item.id) return setExpanded(undefined)
    await grants.loadAudit(item)
    if (request === auditRequest) setExpanded(item.id)
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-8 max-w-[720px]">
          <div>
            <h2 class="text-16-medium text-text-strong">Continuity Grants</h2>
            <p class="text-12-regular text-text-weak">
              Review minimized Assistant-to-Companion handoffs owned by the current source session.
            </p>
          </div>
          <Button size="small" disabled={grants.loading()} onClick={() => void grants.refresh().catch(fail)}>
            Refresh
          </Button>
        </div>
      </div>

      <div class="flex flex-col gap-4 max-w-[720px]">
        <Show
          when={grants.available()}
          fallback={
            <div class="text-14-regular text-text-weak">Open settings from a source session to manage grants.</div>
          }
        >
          <Show when={!grants.loading()} fallback={<div>Loading Continuity grants…</div>}>
            <Show
              when={grants.state.items.length > 0}
              fallback={<div class="text-14-regular text-text-weak">No Continuity grants for this source session.</div>}
            >
              <For each={grants.state.items}>
                {(item) => {
                  const status = () => effectiveContinuityStatus(item)
                  return (
                    <article
                      class="flex flex-col gap-3 rounded-lg bg-surface-base p-4"
                      data-continuity-grant-id={item.id}
                    >
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex flex-wrap gap-2 text-11-regular text-text-weak">
                          <span>{status()}</span>
                          <span>source {item.sourceProfileID}</span>
                          <span>destination {item.destinationProfileID}</span>
                          <span>
                            {item.relationshipPersistence
                              ? "relationship persistence enabled"
                              : "not persisted to relationship Memory"}
                          </span>
                        </div>
                        <span class="text-11-regular text-text-weaker">
                          expires {new Date(item.timeExpires).toISOString()}
                        </span>
                      </div>

                      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-12-regular">
                        <dt class="text-text-weak">Source session</dt>
                        <dd class="break-all text-text-base">{item.sourceSessionID}</dd>
                        <dt class="text-text-weak">Source workspace</dt>
                        <dd class="break-all text-text-base">{item.sourceWorkspaceID ?? "unbound"}</dd>
                        <dt class="text-text-weak">Destination session</dt>
                        <dd class="break-all text-text-base">{item.destinationSessionID}</dd>
                        <dt class="text-text-weak">Destination workspace</dt>
                        <dd class="break-all text-text-base">{item.destinationWorkspaceID}</dd>
                      </dl>

                      <div>
                        <div class="text-11-medium text-text-weak">Purpose</div>
                        <p class="whitespace-pre-wrap text-14-regular text-text-base">{item.purpose}</p>
                      </div>
                      <div>
                        <div class="text-11-medium text-text-weak">Minimized summary</div>
                        <p class="whitespace-pre-wrap text-14-regular text-text-base">{item.summary}</p>
                      </div>

                      <div class="flex flex-wrap gap-2">
                        <Show when={status() === "proposed"}>
                          <Button
                            size="small"
                            disabled={!!grants.state.mutating}
                            onClick={() => {
                              if (
                                !window.confirm("Approve this minimized handoff for the destination Companion session?")
                              )
                                return
                              void grants.approve(item).catch(fail)
                            }}
                          >
                            Approve
                          </Button>
                        </Show>
                        <Show when={status() !== "revoked" && status() !== "expired"}>
                          <Button
                            size="small"
                            disabled={!!grants.state.mutating}
                            onClick={() => {
                              if (!window.confirm("Revoke this continuity grant immediately?")) return
                              void grants.revoke(item).catch(fail)
                            }}
                          >
                            Revoke
                          </Button>
                        </Show>
                        <Button
                          size="small"
                          disabled={grants.state.loadingAudit === item.id}
                          onClick={() => void audit(item).catch(fail)}
                        >
                          {expanded() === item.id ? "Hide audit" : "View audit"}
                        </Button>
                      </div>

                      <Show when={expanded() === item.id}>
                        <div
                          class="flex flex-col gap-2 border-t border-border-weak-base pt-3"
                          data-continuity-audit={item.id}
                        >
                          <For
                            each={grants.state.audit[item.id]}
                            fallback={<div class="text-12-regular text-text-weak">No audit events.</div>}
                          >
                            {(event) => (
                              <div class="text-12-regular text-text-weak">
                                <span>{new Date(event.timeCreated).toISOString()}</span>
                                <span> · {event.action}</span>
                                <span> · {event.outcome}</span>
                                <Show when={event.destinationSessionID}>
                                  <span> · destination {event.destinationSessionID}</span>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </article>
                  )
                }}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

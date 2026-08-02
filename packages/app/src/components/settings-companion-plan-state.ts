import { createMemo } from "solid-js"
import { effectiveContinuityStatus, useContinuityGrantState } from "./settings-continuity-grants-state"
import { useMemoryCenterState } from "./settings-memory-state"
import { useReminderState } from "./settings-reminders-state"
import {
  selectActiveReminders,
  selectMemoryProposals,
  selectReviewableGrants,
} from "./settings-companion-plan-helpers"

export { selectActiveReminders, selectMemoryProposals, selectReviewableGrants } from "./settings-companion-plan-helpers"

export function useCompanionPlanReviewState(sessionID?: string) {
  const memory = useMemoryCenterState(sessionID)
  const reminders = useReminderState(sessionID)
  const continuity = useContinuityGrantState(sessionID)

  const memoryProposals = createMemo(() => selectMemoryProposals(memory.state.items))
  const activeReminders = createMemo(() => selectActiveReminders(reminders.state.items))
  const continuityGrants = createMemo(() => selectReviewableGrants(continuity.state.items))
  const error = createMemo(() => memory.ready.error ?? reminders.error() ?? continuity.ready.error)

  return {
    memory,
    reminders,
    continuity,
    memoryProposals,
    activeReminders,
    continuityGrants,
    loading: () => memory.loading() || reminders.loading() || continuity.loading(),
    error,
    async refreshAll() {
      await Promise.all([memory.refresh(), reminders.refresh(), continuity.refresh()])
    },
    effectiveContinuityStatus,
  }
}

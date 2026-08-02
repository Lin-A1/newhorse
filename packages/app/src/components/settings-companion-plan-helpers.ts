import type { MemoryInfo } from "@newhorse/sdk/v2"
import type { NormalizedReminderInfo } from "./settings-reminders-helpers"
import type { ContinuityGrantInfo } from "./settings-continuity-grants-state"

export function selectMemoryProposals(items: readonly MemoryInfo[]): MemoryInfo[] {
  return items.filter((item) => item.status === "proposed")
}

export function selectActiveReminders(items: readonly NormalizedReminderInfo[]): NormalizedReminderInfo[] {
  return items.filter((item) => !!item.recurrenceRule && (item.status === "pending" || item.status === "paused"))
}

export function selectReviewableGrants(items: readonly ContinuityGrantInfo[]): readonly ContinuityGrantInfo[] {
  return items
}

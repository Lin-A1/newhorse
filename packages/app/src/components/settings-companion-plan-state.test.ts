import { describe, expect, test } from "bun:test"
import type { MemoryInfo } from "@newhorse/sdk/v2"
import type { ContinuityGrantInfo } from "./settings-continuity-grants-state"
import {
  selectActiveReminders,
  selectMemoryProposals,
  selectReviewableGrants,
} from "./settings-companion-plan-helpers"
import type { NormalizedReminderInfo } from "./settings-reminders-helpers"

function memory(id: string, status: MemoryInfo["status"]): MemoryInfo {
  return {
    id,
    content: `Memory ${id}`,
    kind: "fact",
    status,
    scope: "project",
    provenance: "user_explicit",
    sensitivity: "normal",
    timeCreated: 1000,
    timeUpdated: 1000,
  }
}

function reminder(id: string, status: string, recurrenceRule?: string): NormalizedReminderInfo {
  return {
    id,
    profileID: "profile-1",
    type: "reminder",
    title: `Reminder ${id}`,
    body: "Body",
    scheduleAt: 2000,
    timezone: "UTC",
    misfirePolicy: "skip",
    status: status as NormalizedReminderInfo["status"],
    attemptCount: 0,
    timeCreated: 2000,
    timeUpdated: 2000,
    recurrenceRule,
  }
}

function grant(id: string, status: ContinuityGrantInfo["status"]): ContinuityGrantInfo {
  return {
    id,
    sourceWorkspaceID: undefined,
    sourceDirectory: "C:/work",
    sourceProfileID: "assistant",
    sourceSessionID: "ses-source",
    destinationWorkspaceID: "wsp-personal",
    destinationDirectory: "personal",
    destinationProfileID: "companion",
    destinationSessionID: "ses-dest",
    purpose: `Purpose ${id}`,
    summary: "Minimized summary",
    relationshipPersistence: false,
    timeExpires: 10000,
    status,
    timeCreated: 3000,
    timeUpdated: 3000,
  }
}

describe("Companion plan aggregation selectors", () => {
  test("selects only proposed Memory", () => {
    const items = [memory("active", "active"), memory("proposed", "proposed"), memory("rejected", "rejected")]
    expect(selectMemoryProposals(items).map((item) => item.id)).toEqual(["proposed"])
    expect(selectMemoryProposals([])).toEqual([])
  })

  test("selects only recurring pending or paused Reminders", () => {
    const items = [
      reminder("once-pending", "pending"),
      reminder("daily-pending", "pending", "FREQ=DAILY;INTERVAL=1"),
      reminder("weekly-paused", "paused", "FREQ=WEEKLY;INTERVAL=1"),
      reminder("dispatching", "dispatching", "FREQ=DAILY;INTERVAL=1"),
      reminder("delivered", "delivered", "FREQ=DAILY;INTERVAL=1"),
    ]
    expect(selectActiveReminders(items).map((item) => item.id)).toEqual(["daily-pending", "weekly-paused"])
  })

  test("keeps all Continuity grants for review", () => {
    const items = [grant("proposed", "proposed"), grant("revoked", "revoked")]
    expect(selectReviewableGrants(items).map((item) => item.id)).toEqual(["proposed", "revoked"])
  })
})

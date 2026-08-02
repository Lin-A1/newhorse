import type { ReminderListResponses } from "@newhorse/sdk/v2"
import { DateTime } from "luxon"

type GeneratedReminderInfo = ReminderListResponses[200][number]

export type ReminderInfo = GeneratedReminderInfo
export type NormalizedReminderInfo = ReminderInfo

export type ReminderRecurrence = "once" | "daily" | "weekly"

export function normalizeReminder(item: ReminderInfo): NormalizedReminderInfo {
  return item
}

export function reconcileReminder(items: NormalizedReminderInfo[], item: ReminderInfo) {
  const next = items.some((current) => current.id === item.id)
    ? items.map((current) => (current.id === item.id ? normalizeReminder(item) : current))
    : [normalizeReminder(item), ...items]
  return next.toSorted((left, right) => left.scheduleAt - right.scheduleAt || left.timeCreated - right.timeCreated)
}

export function markReminderCancelled(
  items: NormalizedReminderInfo[],
  reminderID: string,
  timeUpdated = Date.now(),
) {
  return items.map((item) =>
    item.id === reminderID ? { ...item, status: "cancelled" as const, timeUpdated } : item,
  )
}

export function recurrenceRule(recurrence: ReminderRecurrence, interval: number) {
  if (recurrence === "once") return undefined
  const count = Number.isInteger(interval) && interval > 0 ? interval : 1
  return `FREQ=${recurrence.toUpperCase()};INTERVAL=${count}`
}

export function parseRecurrenceRule(rule?: string): { recurrence: ReminderRecurrence; interval: number } {
  if (!rule) return { recurrence: "once", interval: 1 }
  const frequency = /(?:^|;)FREQ=(DAILY|WEEKLY)(?:;|$)/i.exec(rule)?.[1]?.toLowerCase()
  const interval = Number.parseInt(/(?:^|;)INTERVAL=(\d+)(?:;|$)/i.exec(rule)?.[1] ?? "1", 10)
  return {
    recurrence: frequency === "weekly" ? "weekly" : "daily",
    interval: Number.isInteger(interval) && interval > 0 ? interval : 1,
  }
}

export function recurrenceSummary(rule?: string) {
  const parsed = parseRecurrenceRule(rule)
  if (parsed.recurrence === "once") return "One-shot"
  const unit = parsed.recurrence === "daily" ? "day" : "week"
  return parsed.interval === 1 ? `Every ${unit}` : `Every ${parsed.interval} ${unit}s`
}

export function parseSchedule(value: string, timezone: string) {
  if (!value.trim()) throw new Error("Schedule must include a date and time")
  const date = DateTime.fromISO(value, { zone: timezone })
  if (!date.isValid) throw new Error(date.invalidExplanation ?? "Schedule or timezone is invalid")
  return date.toMillis()
}

export function scheduleInput(value: number, timezone: string) {
  const date = DateTime.fromMillis(value, { zone: timezone })
  return date.isValid ? date.toFormat("yyyy-LL-dd'T'HH:mm") : ""
}

export function formatNominalTime(value: number, timezone: string) {
  const date = DateTime.fromMillis(value, { zone: timezone })
  return date.isValid ? date.toFormat("yyyy-LL-dd HH:mm ZZZZ") : new Date(value).toISOString()
}

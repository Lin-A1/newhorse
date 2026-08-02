import { DateTime } from "luxon"

export type Rule = { frequency: "daily" | "weekly"; interval: number }

const RECURRENCE = /^FREQ=(DAILY|WEEKLY)(?:;INTERVAL=([1-9]\d{0,2}))?$/

export function parseRule(input: string): Rule | undefined {
  const match = RECURRENCE.exec(input.trim().toUpperCase())
  if (!match) return
  const interval = Number(match[2] ?? 1)
  if (interval > 365) return
  return { frequency: match[1] === "DAILY" ? "daily" : "weekly", interval }
}

export function normalizeRule(input: string) {
  const rule = parseRule(input)
  if (!rule) return
  return `FREQ=${rule.frequency.toUpperCase()};INTERVAL=${rule.interval}`
}

export function nextOccurrence(input: {
  occurrenceAt: number
  recurrenceRule: string
  timezone: string
}): number | undefined {
  const rule = parseRule(input.recurrenceRule)
  if (!rule) return
  const current = DateTime.fromMillis(input.occurrenceAt, { zone: input.timezone })
  if (!current.isValid) return
  const next = current.plus(rule.frequency === "daily" ? { days: rule.interval } : { weeks: rule.interval })
  if (!next.isValid) return
  return next.toMillis()
}

export function occurrencesAfter(input: {
  scheduleAt: number
  recurrenceRule: string
  timezone: string
  now: number
  misfirePolicy: "catch_up_once" | "skip"
}) {
  const rule = parseRule(input.recurrenceRule)
  if (!rule) return
  const scheduled = DateTime.fromMillis(input.scheduleAt, { zone: input.timezone })
  const now = DateTime.fromMillis(input.now, { zone: input.timezone })
  if (!scheduled.isValid || !now.isValid) return
  if (scheduled.toMillis() > now.toMillis()) {
    return { occurrenceAt: undefined, nextScheduleAt: scheduled.toMillis() }
  }

  const unit = rule.frequency === "daily" ? "days" : "weeks"
  const elapsed = Math.max(0, Math.floor(now.diff(scheduled, unit).get(unit)))
  const steps = Math.floor(elapsed / rule.interval)
  let latest = scheduled.plus({ [unit]: steps * rule.interval })
  let next = latest.plus({ [unit]: rule.interval })
  while (next.toMillis() <= input.now) {
    latest = next
    next = next.plus({ [unit]: rule.interval })
  }
  if (!latest.isValid || !next.isValid) return
  return {
    occurrenceAt: input.misfirePolicy === "catch_up_once" ? latest.toMillis() : undefined,
    nextScheduleAt: next.toMillis(),
  }
}

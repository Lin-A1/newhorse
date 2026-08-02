import { createOpencodeClient, type ReminderAuditResponses, type ReminderListResponses } from "@newhorse/sdk/v2"

export type ReminderInfo = ReminderListResponses[200][number]
type ReminderClient = ReturnType<typeof createOpencodeClient>["reminder"]
export type ReminderRouting = { session?: string }
export type ReminderDialogValue = { type: "record"; item: ReminderInfo } | { type: "create" }

async function required<T>(request: Promise<{ data?: T; error?: unknown }>, message: string) {
  const response = await request
  if (response.data !== undefined) return response.data
  throw new Error(message, { cause: response.error })
}

export function reminderDetails(item: ReminderInfo) {
  return [
    `${item.type.replaceAll("_", " ")} · profile ${item.profileID}`,
    `${new Date(item.scheduleAt).toISOString()} · ${item.timezone}`,
    item.recurrenceRule ?? "one-shot",
    item.lastError ? `error: ${item.lastError}` : undefined,
  ].filter((value): value is string => value !== undefined)
}

export function parseReminderSchedule(value: string) {
  const time = new Date(value.trim()).getTime()
  if (!Number.isFinite(time)) throw new Error("Schedule must be an ISO date/time")
  return time
}

export function normalizeReminderRule(value: string) {
  const input = value.trim().toUpperCase()
  if (!input) return undefined
  const match = /^FREQ=(DAILY|WEEKLY)(?:;INTERVAL=([1-9]\d{0,2}))?$/.exec(input)
  if (!match) throw new Error("Recurrence must be FREQ=DAILY or FREQ=WEEKLY with optional INTERVAL=1..365")
  const interval = Number(match[2] ?? 1)
  if (interval > 365) throw new Error("Recurrence interval cannot exceed 365")
  return `FREQ=${match[1]};INTERVAL=${interval}`
}

export function reminderCreate(
  client: ReminderClient,
  routing: ReminderRouting,
  input: {
    title: string
    body: string
    scheduleAt: number
    timezone: string
    recurrenceRule?: string
    misfirePolicy: "catch_up_once" | "skip"
  },
) {
  return required(
    client.create({
      ...routing,
      title: input.title,
      body: input.body,
      scheduleAt: input.scheduleAt,
      timezone: input.timezone,
      recurrenceRule: input.recurrenceRule,
      misfirePolicy: input.misfirePolicy,
    }),
    "Reminder creation failed",
  )
}

export function reminderUpdate(
  client: ReminderClient,
  routing: ReminderRouting,
  item: ReminderInfo,
  input: {
    title: string
    body: string
    scheduleAt: number
    timezone: string
    recurrenceRule?: string
    misfirePolicy: "catch_up_once" | "skip"
  },
) {
  return required(
    client.update({
      ...routing,
      reminderID: item.id,
      title: input.title,
      body: input.body,
      scheduleAt: input.scheduleAt,
      timezone: input.timezone,
      recurrenceRule: input.recurrenceRule,
      clearRecurrence: input.recurrenceRule ? undefined : true,
      misfirePolicy: input.misfirePolicy,
    }),
    "Reminder update failed",
  )
}

export function reminderPause(
  client: ReminderClient,
  routing: ReminderRouting,
  item: ReminderInfo,
  paused: boolean,
) {
  return required(client.update({ ...routing, reminderID: item.id, paused }), "Reminder pause failed")
}

export function reminderAudit(client: ReminderClient, routing: ReminderRouting, item: ReminderInfo) {
  return required<ReminderAuditResponses[200]>(
    client.audit({ ...routing, reminderID: item.id, limit: "50" }),
    "Reminder audit failed",
  )
}

export function reminderCancel(client: ReminderClient, routing: ReminderRouting, item: ReminderInfo) {
  return required(client.cancel({ ...routing, reminderID: item.id }), "Reminder cancellation failed")
}

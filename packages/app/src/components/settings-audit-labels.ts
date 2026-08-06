type Translate = (key: string, params?: Record<string, string | number | boolean>) => string

// Mirror the union of `ContinuityGrantAuditResponse["action"]` from the SDK.
const continuityActions: ReadonlySet<string> = new Set(["proposed", "approved", "injected", "revoked"])

// Mirror the union of `ReminderAuditResponse["action"]` from the SDK.
const reminderActions: ReadonlySet<string> = new Set([
  "created",
  "updated",
  "paused",
  "resumed",
  "cancelled",
  "claimed",
  "deferred",
  "staged",
  "skipped",
  "delivered",
  "failed",
  "recovered",
  "retry_scheduled",
])

// Reminder outcomes are an unbounded server string; translate the known set and
// fall back to the raw value so an unknown outcome never shows a bare key.
const outcomeKeys: Record<string, string> = {
  success: "settings.audit.outcome.success",
  policy: "settings.audit.outcome.policy",
  missed_window: "settings.audit.outcome.missedWindow",
  quiet_hours: "settings.audit.outcome.quietHours",
  frequency_limit: "settings.audit.outcome.frequencyLimit",
  invalid_recurrence: "settings.audit.outcome.invalidRecurrence",
  lease_expired: "settings.audit.outcome.leaseExpired",
  attempts_exhausted: "settings.audit.outcome.attemptsExhausted",
}

export function auditActionLabel(t: Translate, domain: "continuity" | "reminder", value: string): string {
  const known = domain === "continuity" ? continuityActions : reminderActions
  return known.has(value) ? t(`settings.audit.action.${domain}.${value}`) : value
}

export function auditOutcomeLabel(t: Translate, value: string): string {
  const key = outcomeKeys[value]
  return key ? t(key) : value
}

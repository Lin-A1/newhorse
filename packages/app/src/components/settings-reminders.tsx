import { Button } from "@newhorse/ui/button"
import { Spinner } from "@newhorse/ui/spinner"
import { Select } from "@newhorse/ui/select"
import { Switch } from "@newhorse/ui/switch"
import { TextField } from "@newhorse/ui/text-field"
import { DateTime } from "luxon"
import { For, Show, createSignal } from "solid-js"
import type { ReminderAuditResponses } from "@newhorse/sdk/v2"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import {
  formatNominalTime,
  parseRecurrenceRule,
  parseSchedule,
  recurrenceRule,
  recurrenceSummary,
  scheduleInput,
  type ReminderRecurrence,
} from "./settings-reminders-helpers"
import { auditActionLabel, auditOutcomeLabel } from "./settings-audit-labels"
import { useConfirm } from "./confirm-dialog"
import {
  useReminderState,
  type ReminderCreateInput,
  type ReminderInfo,
  type ReminderUpdateInput,
} from "./settings-reminders-state"

const recurrences: ReminderRecurrence[] = ["once", "daily", "weekly"]
const reminderTypes: ReminderInfo["type"][] = ["reminder", "check_in", "follow_up"]
const misfirePolicies: ReminderInfo["misfirePolicy"][] = ["catch_up_once", "skip"]

export function SettingsReminders(props: { sessionID?: string }) {
  const language = useLanguage()
  const reminders = useReminderState(props.sessionID)
  const confirm = useConfirm()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const [creating, setCreating] = createSignal(false)
  const [editing, setEditing] = createSignal<string>()
  const [form, setForm] = createSignal(formDefaults(timezone))
  const [audits, setAudits] = createSignal<Record<string, ReminderAuditResponses[200] | undefined>>({})

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.reminders.title"),
      description: formatServerError(error, undefined, language.t("common.requestFailed")),
    })

  const beginCreate = () => {
    setEditing(undefined)
    setForm(formDefaults(timezone))
    setCreating(true)
  }

  const beginEdit = (item: ReminderInfo) => {
    const parsed = parseRecurrenceRule(item.recurrenceRule)
    setCreating(false)
    setEditing(item.id)
    setForm({
      type: item.type,
      title: item.title,
      body: item.body,
      schedule: scheduleInput(item.scheduleAt, item.timezone),
      timezone: item.timezone,
      recurrence: parsed.recurrence,
      interval: String(parsed.interval),
      misfirePolicy: item.misfirePolicy,
      paused: item.status === "paused",
    })
  }

  const updateForm = <K extends keyof ReminderForm>(key: K, value: ReminderForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const input = () => {
    const current = form()
    const scheduleAt = parseSchedule(current.schedule, current.timezone)
    const interval = Number.parseInt(current.interval, 10)
    if (!current.title.trim()) throw new Error(language.t("settings.reminders.error.titleRequired"))
    if (!current.body.trim()) throw new Error(language.t("settings.reminders.error.bodyRequired"))
    if (current.recurrence !== "once" && (!Number.isInteger(interval) || interval < 1)) {
      throw new Error(language.t("settings.reminders.error.interval"))
    }
    return {
      type: current.type,
      title: current.title.trim(),
      body: current.body.trim(),
      scheduleAt,
      timezone: current.timezone,
      recurrenceRule: recurrenceRule(current.recurrence, interval),
      misfirePolicy: current.misfirePolicy,
    } satisfies ReminderCreateInput
  }

  const create = async () => {
    try {
      await reminders.create(input())
      setCreating(false)
    } catch (error) {
      fail(error)
    }
  }

  const save = async (item: ReminderInfo) => {
    try {
      const value = input()
      const current = form()
      const update = {
        title: value.title,
        body: value.body,
        scheduleAt: value.scheduleAt,
        timezone: value.timezone,
        recurrenceRule: value.recurrenceRule,
        clearRecurrence: value.recurrenceRule ? undefined : true,
        misfirePolicy: value.misfirePolicy,
        paused: current.recurrence === "once" ? false : current.paused,
      } satisfies ReminderUpdateInput
      await reminders.update(item, update)
      setEditing(undefined)
    } catch (error) {
      fail(error)
    }
  }

  const loadAudit = async (item: ReminderInfo, cursor?: string) => {
    if (!cursor && audits()[item.id]) {
      setAudits((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== item.id)))
      return
    }
    try {
      const page = await reminders.audit(item, cursor)
      setAudits((current) => {
        const existing = current[item.id]
        if (!cursor || !existing) return { ...current, [item.id]: page }
        const items = new Map(existing.items.map((entry) => [entry.id, entry]))
        page.items.forEach((entry) => items.set(entry.id, entry))
        return { ...current, [item.id]: { items: [...items.values()], nextCursor: page.nextCursor } }
      })
    } catch (error) {
      fail(error)
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-8 max-w-[720px]">
          <div>
            <h2 class="text-16-medium text-text-strong">{language.t("settings.reminders.title")}</h2>
            <p class="text-12-regular text-text-weak">{language.t("settings.reminders.description")}</p>
          </div>
          <div class="flex gap-2">
            <Button size="small" disabled={reminders.loading()} onClick={() => void reminders.refresh().catch(fail)}>
              {language.t("common.refresh")}
            </Button>
            <Button size="small" disabled={!!reminders.state.mutating} onClick={beginCreate}>
              {language.t("settings.reminders.new")}
            </Button>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-4 max-w-[720px]">
        <Show when={creating()}>
          <ReminderEditor
            language={language}
            form={form()}
            update={updateForm}
            disabled={!!reminders.state.mutating}
            save={() => void create()}
            cancel={() => setCreating(false)}
            submitLabel={language.t("settings.reminders.create")}
            showType
          />
        </Show>

        <Show
          when={!reminders.error()}
          fallback={
            <div class="flex items-center gap-3 text-14-regular text-text-weak">
              <span>{language.t("settings.reminders.unavailable")}</span>
              <Button size="small" onClick={() => void reminders.refresh().catch(fail)}>
                {language.t("common.retry")}
              </Button>
            </div>
          }
        >
          <Show when={!reminders.loading()} fallback={<div>{language.t("settings.reminders.loading")}</div>}>
            <Show
              when={reminders.state.items.length > 0}
              fallback={<div class="text-14-regular text-text-weak">{language.t("settings.reminders.empty")}</div>}
            >
              <For each={reminders.state.items}>
                {(item) => (
                  <article class="flex flex-col gap-3 rounded-lg bg-surface-base p-4" data-reminder-id={item.id}>
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="flex flex-wrap gap-2 text-11-regular text-text-weak">
                        <span>{reminderStatusLabel(language.t, item.status)}</span>
                        <span>{language.t("settings.reminders.profile", { id: item.profileID })}</span>
                        <span>{reminderTypeLabel(language.t, item.type)}</span>
                      </div>
                      <span class="text-11-regular text-text-weaker">{recurrenceSummary(language.t, item.recurrenceRule)}</span>
                    </div>

                    <Show when={editing() === item.id}>
                      <ReminderEditor
                        language={language}
                        form={form()}
                        update={updateForm}
                        disabled={!!reminders.state.mutating}
                        save={() => void save(item)}
                        cancel={() => setEditing(undefined)}
                        submitLabel={language.t("common.save")}
                      />
                    </Show>

                    <Show when={editing() !== item.id}>
                      <div>
                        <h3 class="text-14-medium text-text-strong">{item.title}</h3>
                        <p class="whitespace-pre-wrap text-14-regular text-text-base">{item.body}</p>
                      </div>
                      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-12-regular">
                        <dt class="text-text-weak">{language.t("settings.reminders.editor.schedule")}</dt>
                        <dd class="text-text-base">{formatNominalTime(item.scheduleAt, item.timezone)}</dd>
                        <dt class="text-text-weak">{language.t("settings.reminders.editor.timezone")}</dt>
                        <dd class="text-text-base">{item.timezone}</dd>
                        <dt class="text-text-weak">{language.t("settings.reminders.editor.recurrence")}</dt>
                        <dd class="text-text-base">{recurrenceSummary(language.t, item.recurrenceRule)}</dd>
                        <dt class="text-text-weak">{language.t("settings.reminders.editor.misfirePolicy")}</dt>
                        <dd class="text-text-base">{misfireLabel(language.t, item.misfirePolicy)}</dd>
                      </dl>
                      <Show when={item.lastError}>
                        <p class="text-12-regular text-text-weak">
                          {language.t("settings.reminders.lastError", { error: item.lastError ?? "" })}
                        </p>
                      </Show>
                      <div class="flex flex-wrap items-center gap-2">
                        <Show when={reminders.state.mutating === item.id}>
                          <Spinner class="size-3.5 shrink-0 text-text-weak" />
                        </Show>
                        <Button size="small" disabled={!!reminders.state.mutating} onClick={() => beginEdit(item)}>
                          {language.t("common.edit")}
                        </Button>
                        <Button size="small" disabled={!!reminders.state.mutating} onClick={() => void loadAudit(item)}>
                          {audits()[item.id]
                            ? language.t("settings.reminders.audit.hide")
                            : language.t("settings.reminders.audit.show")}
                        </Button>
                        <Show when={item.recurrenceRule && (item.status === "pending" || item.status === "paused")}>
                          <Button
                            size="small"
                            disabled={!!reminders.state.mutating}
                            onClick={() => void reminders.pause(item, item.status !== "paused").catch(fail)}
                          >
                            {item.status === "paused" ? language.t("common.resume") : language.t("common.pause")}
                          </Button>
                        </Show>
                        <Show when={item.status !== "cancelled" && item.status !== "delivered"}>
                          <Button
                            size="small"
                            disabled={!!reminders.state.mutating}
                            onClick={() => {
                              void (async () => {
                                const confirmed = await confirm({
                                  title: language.t("common.cancel"),
                                  message: language.t("settings.reminders.cancel.confirm"),
                                })
                                if (!confirmed) return
                                void reminders.cancel(item).catch(fail)
                              })()
                            }}
                          >
                            {language.t("common.cancel")}
                          </Button>
                        </Show>
                      </div>
                      <Show when={audits()[item.id]}>
                        {(page) => (
                          <div
                            data-reminder-audit={item.id}
                            class="flex flex-col gap-1 border-t border-border-weak-base pt-3 text-11-regular text-text-weak"
                          >
                            <For each={page().items}>
                              {(entry) => (
                                <div data-reminder-audit-id={entry.id}>
                                  {language.t("settings.audit.action", {
                                    time: formatDate(entry.timeCreated),
                                    action: auditActionLabel(language.t, "reminder", entry.action),
                                    outcome: auditOutcomeLabel(language.t, entry.outcome),
                                  })}
                                  {entry.deliveryKey ? ` · ${entry.deliveryKey}` : ""}
                                </div>
                              )}
                            </For>
                            <Show when={page().nextCursor}>
                              {(cursor) => (
                                <Button size="small" onClick={() => void loadAudit(item, cursor())}>
                                  {language.t("settings.reminders.audit.loadMore")}
                                </Button>
                              )}
                            </Show>
                          </div>
                        )}
                      </Show>
                    </Show>
                  </article>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

type ReminderForm = {
  type: ReminderInfo["type"]
  title: string
  body: string
  schedule: string
  timezone: string
  recurrence: ReminderRecurrence
  interval: string
  misfirePolicy: ReminderInfo["misfirePolicy"]
  paused: boolean
}

function formDefaults(timezone: string): ReminderForm {
  const nextHour = DateTime.now().setZone(timezone).plus({ hours: 1 }).startOf("minute")
  return {
    type: "reminder",
    title: "",
    body: "",
    schedule: nextHour.toFormat("yyyy-LL-dd'T'HH:mm"),
    timezone,
    recurrence: "once",
    interval: "1",
    misfirePolicy: "catch_up_once",
    paused: false,
  }
}

function ReminderEditor(props: {
  language: ReturnType<typeof useLanguage>
  form: ReminderForm
  update: <K extends keyof ReminderForm>(key: K, value: ReminderForm[K]) => void
  disabled: boolean
  save: () => void
  cancel: () => void
  submitLabel: string
  showType?: boolean
}) {
  const { language } = props
  return (
    <div class="flex flex-col gap-3 rounded-lg bg-surface-base p-4" data-reminder-editor>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label={language.t("settings.reminders.editor.title")}
          value={props.form.title}
          onChange={(value) => props.update("title", value)}
          required
        />
        <Show when={props.showType}>
          <Select
            options={reminderTypes}
            current={props.form.type}
            label={(value) => reminderTypeLabel(language.t, value)}
            onSelect={(value) => value && props.update("type", value)}
            variant="secondary"
            size="small"
            triggerProps={{ "aria-label": language.t("settings.reminders.editor.type") }}
          />
        </Show>
      </div>
      <TextField
        label={language.t("settings.reminders.editor.body")}
        multiline
        value={props.form.body}
        onChange={(value) => props.update("body", value)}
        required
      />
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label={language.t("settings.reminders.editor.schedule")}
          type="datetime-local"
          value={props.form.schedule}
          onChange={(value) => props.update("schedule", value)}
          required
        />
        <TextField
          label={language.t("settings.reminders.editor.timezone")}
          value={props.form.timezone}
          onChange={(value) => props.update("timezone", value)}
          required
        />
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select
          options={recurrences}
          current={props.form.recurrence}
          label={(value) => recurrenceLabel(language.t, value)}
          onSelect={(value) => value && props.update("recurrence", value)}
          variant="secondary"
          size="small"
          triggerProps={{ "aria-label": language.t("settings.reminders.editor.recurrence") }}
        />
        <Show when={props.form.recurrence !== "once"}>
          <TextField
            label={language.t("settings.reminders.editor.interval")}
            type="number"
            min="1"
            step="1"
            value={props.form.interval}
            onChange={(value) => props.update("interval", value)}
          />
        </Show>
        <Select
          options={misfirePolicies}
          current={props.form.misfirePolicy}
          label={(value) => misfireLabel(language.t, value)}
          onSelect={(value) => value && props.update("misfirePolicy", value)}
          variant="secondary"
          size="small"
          triggerProps={{ "aria-label": language.t("settings.reminders.editor.misfirePolicy") }}
        />
      </div>
      <Show when={props.form.recurrence !== "once"}>
        <Switch checked={props.form.paused} onChange={(value) => props.update("paused", value)}>
          {language.t("settings.reminders.editor.pauseFuture")}
        </Switch>
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button size="small" disabled={props.disabled} onClick={props.save}>
          {props.submitLabel}
        </Button>
        <Button size="small" disabled={props.disabled} onClick={props.cancel}>
          {language.t("common.cancel")}
        </Button>
      </div>
    </div>
  )
}

function formatDate(value: number) {
  return new Date(value).toLocaleString()
}

function reminderTypeLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  value: ReminderInfo["type"],
) {
  return t(`settings.reminders.type.${value}`)
}

function reminderStatusLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  value: ReminderInfo["status"],
) {
  return t(`settings.reminders.status.${value}`)
}

export { reminderStatusLabel }

function recurrenceLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  value: ReminderRecurrence,
) {
  switch (value) {
    case "once":
      return t("settings.reminders.editor.recurrence.once")
    case "daily":
      return t("settings.reminders.editor.recurrence.daily")
    case "weekly":
      return t("settings.reminders.editor.recurrence.weekly")
  }
}

function misfireLabel(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  value: ReminderInfo["misfirePolicy"],
) {
  switch (value) {
    case "catch_up_once":
      return t("settings.reminders.editor.misfire.catchUpOnce")
    case "skip":
      return t("settings.reminders.editor.misfire.skip")
  }
}

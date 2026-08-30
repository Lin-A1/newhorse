import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Scheduled prompts (定时任务) — the engine-side half of the client's schedule
 * page. A schedule targets a SESSION with a PROMPT and fires by time:
 *   - `{ intervalMinutes: N }` — every N minutes
 *   - `{ dailyAt: "HH:MM" }`   — once per day at that local time
 *   - `{ cron: "m h dom mon dow" }` — 5-field cron (star, star-step, bare
 *     numbers, ranges, comma lists); local time
 * The server owns the tick loop and the `fire` callback (admit the prompt as
 * a user prompt into the target session); the scheduler owns ORDER, due-time
 * computation, persistence and run bookkeeping. State is one JSON file under
 * the agent data dir (schedule rows are small; crash-safe atomic write).
 */
export interface Schedule {
  readonly id: string
  readonly sessionId: string
  readonly prompt: string
  readonly enabled: boolean
  readonly intervalMinutes?: number
  readonly dailyAt?: string
  readonly cron?: string
  readonly createdAt: number
  readonly lastRunAt?: number
  readonly lastResult?: "ok" | "error"
  readonly lastError?: string
}

export interface ScheduleInput {
  readonly sessionId: string
  readonly prompt: string
  readonly enabled?: boolean
  readonly intervalMinutes?: number
  readonly dailyAt?: string
  readonly cron?: string
}

export interface Scheduler {
  readonly list: () => Promise<Schedule[]>
  readonly get: (id: string) => Schedule | undefined
  readonly add: (input: ScheduleInput) => Promise<Schedule>
  readonly update: (id: string, patch: Partial<ScheduleInput>) => Promise<Schedule | undefined>
  readonly remove: (id: string) => Promise<boolean>
  /** Run one schedule immediately (ignores enabled/due — the UI's "run now"). */
  readonly runNow: (id: string) => Promise<boolean>
  /** Fire every DUE enabled schedule (the server's tick calls this). */
  readonly tick: (now?: number) => Promise<string[]>
  readonly close?: () => void
}

/** Does a cron field value match at time `d`? Supports star, star-slash-N
 *  (step), a bare number, a range N-M, comma lists, and list-with-step. */
function cronFieldMatch(field: string, value: number, max: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/")
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step <= 0) continue
    let lo = 0
    let hi = max
    if (range !== "*" && range !== undefined) {
      const [a, b] = range.split("-")
      lo = Number(a)
      hi = b !== undefined ? Number(b) : lo
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) continue
    }
    for (let v = lo; v <= hi; v += step) if (v === value) return true
  }
  return false
}

/** Validate a 5-field cron expression (parse each field; throws on garbage). */
export function validateCron(expr: string): void {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`cron needs 5 fields (m h dom mon dow), got ${fields.length}`)
  const maxes = [59, 23, 31, 12, 6]
  fields.forEach((f, i) => {
    if (!cronFieldMatch(f, 0, maxes[i]!)) {
      // `0` may legitimately not match (e.g. `*/5` matches 0 — fine; `5` alone does not) —
      // re-test against a value inside the field's own range instead.
      const probe = f === "*" || f.startsWith("*/") ? 0 : Number(f.split(",")[0]!.split("-")[0]!.split("/")[0]!)
      if (!Number.isInteger(probe) || probe < 0 || probe > maxes[i]!) throw new Error(`cron field ${i + 1} out of range: ${f}`)
    }
  })
}

/** Cron field match at a local time. */
function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return (
    cronFieldMatch(fields[0]!, d.getMinutes(), 59) &&
    cronFieldMatch(fields[1]!, d.getHours(), 23) &&
    cronFieldMatch(fields[2]!, d.getDate(), 31) &&
    cronFieldMatch(fields[3]!, d.getMonth() + 1, 12) &&
    cronFieldMatch(fields[4]!, d.getDay(), 6)
  )
}

/** Next due epoch-ms for a schedule strictly AFTER `after`. Undefined when
 *  the schedule shape is invalid/disabled. Minute-resolution scan (cron is
 *  minute-resolution by definition; ≤ 366 days then give up). */
export function nextDue(s: Pick<Schedule, "intervalMinutes" | "dailyAt" | "cron">, after: number): number | undefined {
  if (s.intervalMinutes !== undefined) {
    if (!Number.isFinite(s.intervalMinutes) || s.intervalMinutes <= 0) return undefined
    const step = s.intervalMinutes * 60_000
    return after + step
  }
  if (s.dailyAt !== undefined) {
    const parts = s.dailyAt.split(":").map(Number)
    const h = parts[0]!
    const m = parts[1]!
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return undefined
    const d = new Date(after)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0)
    if (next.getTime() <= after) next.setDate(next.getDate() + 1)
    return next.getTime()
  }
  if (s.cron !== undefined) {
    const cursor = new Date(after)
    cursor.setSeconds(0, 0)
    for (let i = 0; i < 366 * 24 * 60; i++) {
      cursor.setMinutes(cursor.getMinutes() + 1)
      if (cronMatches(s.cron, cursor)) return cursor.getTime()
    }
    return undefined
  }
  return undefined
}

/** Parse + validate a schedule input (throws with a user-facing message). */
export function validateScheduleInput(input: ScheduleInput): void {
  if (!input.sessionId) throw new Error("sessionId is required")
  if (!input.prompt || !input.prompt.trim()) throw new Error("prompt is required")
  const kinds = [input.intervalMinutes !== undefined, input.dailyAt !== undefined, input.cron !== undefined].filter(Boolean).length
  if (kinds !== 1) throw new Error("exactly one of intervalMinutes | dailyAt | cron is required")
  if (input.cron !== undefined) validateCron(input.cron)
  if (input.intervalMinutes !== undefined && (!Number.isFinite(input.intervalMinutes) || input.intervalMinutes < 1)) throw new Error("intervalMinutes must be >= 1")
  if (input.dailyAt !== undefined && !/^\d{2}:\d{2}$/.test(input.dailyAt)) throw new Error('dailyAt must be "HH:MM"')
}

export function createScheduler(opts: { file: string; fire: (schedule: Schedule) => Promise<void> }): Scheduler {
  const { file, fire } = opts
  let rows: Schedule[] = []
  let loaded = false

  async function load(): Promise<void> {
    if (loaded) return
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { schedules?: Schedule[] }
      rows = Array.isArray(raw.schedules) ? raw.schedules : []
    } catch {
      rows = []
    }
    loaded = true
  }

  async function persist(): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ schedules: rows }, null, 2) + "\n", "utf8")
  }

  const due = (s: Schedule, now: number): boolean => {
    if (!s.enabled) return false
    const next = nextDue(s, s.lastRunAt ?? s.createdAt)
    return next !== undefined && next <= now
  }

  async function run(s: Schedule): Promise<void> {
    try {
      await fire(s)
      s = { ...s, lastRunAt: Date.now(), lastResult: "ok", lastError: undefined }
    } catch (e) {
      s = { ...s, lastRunAt: Date.now(), lastResult: "error", lastError: e instanceof Error ? e.message : String(e) }
    }
    const idx = rows.findIndex((r) => r.id === s.id)
    if (idx >= 0) rows[idx] = s
    await persist()
  }

  return {
    async list() {
      await load()
      return [...rows].sort((a, b) => b.createdAt - a.createdAt)
    },
    get(id) {
      return rows.find((r) => r.id === id)
    },
    async add(input) {
      await load()
      validateScheduleInput(input)
      const s: Schedule = { ...input, enabled: input.enabled ?? true, id: crypto.randomUUID(), createdAt: Date.now() }
      rows.push(s)
      await persist()
      return s
    },
    async update(id, patch) {
      await load()
      const idx = rows.findIndex((r) => r.id === id)
      if (idx < 0) return undefined
      validateScheduleInput({ ...rows[idx]!, ...patch } as ScheduleInput)
      rows[idx] = { ...rows[idx]!, ...patch }
      await persist()
      return rows[idx]
    },
    async remove(id) {
      await load()
      const before = rows.length
      rows = rows.filter((r) => r.id !== id)
      if (rows.length !== before) await persist()
      return rows.length !== before
    },
    async runNow(id) {
      await load()
      const s = rows.find((r) => r.id === id)
      if (!s) return false
      await run(s)
      return true
    },
    async tick(now = Date.now()) {
      await load()
      const fired: string[] = []
      for (const s of [...rows]) {
        if (due(s, now)) {
          fired.push(s.id)
          await run(s)
        }
      }
      return fired
    },
  }
}

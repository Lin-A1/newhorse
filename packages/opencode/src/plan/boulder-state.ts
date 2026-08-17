import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@newhorse/core/fs-util"
import { Global } from "@newhorse/core/global"
import type { InstanceContext } from "@/project/instance-context"

/**
 * Cross-session plan resume state ("boulder-state").
 *
 * The state records which plan markdown file is currently active plus every
 * session that contributed to it, so a build agent taking over the plan later
 * (same session, a `--continue` resumed session, or another session in the same
 * workspace) can resume it with checkbox progress instead of starting blind.
 *
 * Modeled after the SUL-1.0 oh-my-opencode boulder-state pattern.
 */

export interface BoulderState {
  active_plan: string
  started_at: string
  session_ids: string[]
  plan_name: string
  goal_id?: string
}

export interface PlanProgress {
  total: number
  completed: number
  isComplete: boolean
}

/** A completed checkbox list item, e.g. `- [x]` or `* [X]`. */
const COMPLETED_RE = /^[-*]\s*\[[xX]\s*\]/gm
/** An open (unchecked) checkbox list item, e.g. `- [ ]` or `* [ ]`. */
const OPEN_RE = /^[-*]\s*\[\s*\]/gm

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0
  let count = 0
  while (re.exec(text) !== null) count++
  re.lastIndex = 0
  return count
}

/** Derives plan progress from the markdown checkboxes in a plan file. */
export function parsePlanProgress(markdown: string): PlanProgress {
  const completed = countMatches(markdown, COMPLETED_RE)
  const open = countMatches(markdown, OPEN_RE)
  const total = completed + open
  return { total, completed, isComplete: total > 0 && completed === total }
}

/** Location of the boulder state file, mirroring where v1 plans are stored. */
export function statePath(instance: InstanceContext): string {
  const base = instance.project.vcs ? path.join(instance.worktree, ".opencode") : Global.Path.data
  return path.join(base, "boulder.json")
}

/** The plan's display name (slug) derived from a `{timestamp}-{slug}.md` path. */
export function planName(planPath: string): string {
  const base = path.basename(planPath, ".md")
  const dash = base.indexOf("-")
  return dash > 0 ? base.slice(dash + 1) : base
}

/** Validates/normalizes a raw parsed value into a `BoulderState`, or undefined. */
export function parseState(value: unknown): BoulderState | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const obj = value as Record<string, unknown>
  if (typeof obj.active_plan !== "string") return undefined
  return {
    active_plan: obj.active_plan,
    started_at: typeof obj.started_at === "string" ? obj.started_at : "",
    session_ids: Array.isArray(obj.session_ids)
      ? obj.session_ids.filter((id): id is string => typeof id === "string")
      : [],
    plan_name: typeof obj.plan_name === "string" ? obj.plan_name : "",
    goal_id: typeof obj.goal_id === "string" ? obj.goal_id : undefined,
  }
}

/** Reads the current boulder state for an instance, or undefined when absent/corrupt. */
export const getState = Effect.fn("BoulderState.getState")(function* (instance: InstanceContext) {
  const fsys = yield* FSUtil.Service
  return yield* readState(fsys, statePath(instance))
})

function readState(fsys: FSUtil.Interface, file: string): Effect.Effect<BoulderState | undefined> {
  return Effect.gen(function* () {
    const exists = yield* fsys.existsSafe(file)
    if (!exists) return undefined
    const raw = yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => undefined))
    return raw === undefined ? undefined : parseState(raw)
  })
}

/** Records a new active plan. Best-effort: a write failure never breaks the session. */
export const createState = Effect.fn("BoulderState.createState")(function* (
  instance: InstanceContext,
  input: { activePlan: string; planName: string; sessionID: string; startedAt?: string; goalID?: string },
) {
  const fsys = yield* FSUtil.Service
  const file = statePath(instance)
  const state: BoulderState = {
    active_plan: input.activePlan,
    started_at: input.startedAt ?? new Date().toISOString(),
    session_ids: [input.sessionID],
    plan_name: input.planName,
    goal_id: input.goalID,
  }
  yield* fsys.ensureDir(path.dirname(file)).pipe(Effect.orElseSucceed(() => undefined))
  yield* fsys.writeJson(file, state).pipe(Effect.orElseSucceed(() => undefined))
  return state
})

/**
 * Links the active plan's state to a goal. No-op when no plan state exists or
 * the state is already linked, so the first goal created under a plan wins.
 * Takes the filesystem service so callers (e.g. tool executes) can capture it
 * at init rather than requiring `FSUtil.Service` in the calling effect.
 */
export const associateGoalId = Effect.fn("BoulderState.associateGoalId")(function* (
  fsys: FSUtil.Interface,
  instance: InstanceContext,
  goalID: string,
) {
  const file = statePath(instance)
  const state = yield* readState(fsys, file)
  if (!state || state.goal_id !== undefined) return state
  state.goal_id = goalID
  yield* fsys.writeJson(file, state).pipe(Effect.orElseSucceed(() => undefined))
  return state
})

/** Adds a session to the active state's `session_ids` (deduped). No-op without state. */
export const appendSessionId = Effect.fn("BoulderState.appendSessionId")(function* (
  instance: InstanceContext,
  sessionID: string,
) {
  const fsys = yield* FSUtil.Service
  const state = yield* getState(instance)
  if (!state) return undefined
  if (state.session_ids.includes(sessionID)) return state
  state.session_ids.push(sessionID)
  yield* fsys.writeJson(statePath(instance), state).pipe(Effect.orElseSucceed(() => undefined))
  return state
})

/** Deletes the boulder state file. Returns whether a state file existed. */
export const clearState = Effect.fn("BoulderState.clearState")(function* (instance: InstanceContext) {
  const fsys = yield* FSUtil.Service
  const file = statePath(instance)
  const exists = yield* fsys.existsSafe(file)
  if (!exists) return false
  yield* fsys.remove(file).pipe(Effect.orElseSucceed(() => undefined))
  return true
})

/** Reads a plan file and derives its checkbox progress. Empty/missing → 0/0. */
export const getPlanProgress = Effect.fn("BoulderState.getPlanProgress")(function* (planPath: string) {
  const fsys = yield* FSUtil.Service
  const content = yield* fsys.readFileStringSafe(planPath)
  return content === undefined ? { total: 0, completed: 0, isComplete: false } : parsePlanProgress(content)
})

/** Builds the resume context injected when a build agent takes over an active plan. */
export function resumePrompt(input: {
  planPath: string
  planName: string
  startedAt: string
  progress: PlanProgress
  goalID?: string
}): string {
  const status = input.progress.isComplete
    ? "all checkboxes are complete"
    : `${input.progress.completed}/${input.progress.total} checkboxes complete`
  return [
    `<system-reminder>`,
    `You are resuming an existing plan started in a previous session.`,
    `Plan: ${input.planName}`,
    `Plan file: ${input.planPath}`,
    `Started: ${input.startedAt}`,
    `Progress: ${status}`,
    ...(input.goalID ? [`Linked goal: ${input.goalID} (query it with the goal tool)`] : []),
    ``,
    `Read the plan file and continue executing it. Tick each task's checkbox in the plan file with the edit tool as you complete it.`,
    `</system-reminder>`,
  ].join("\n")
}

export * as BoulderState from "./boulder-state"

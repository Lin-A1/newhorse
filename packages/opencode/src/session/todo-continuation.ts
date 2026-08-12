import { LayerNode } from "@newhorse/core/effect/layer-node"
import { EventV2 } from "@newhorse/core/event"
import { ModelV2 } from "@newhorse/core/model"
import { PermissionV1 } from "@newhorse/core/v1/permission"
import { ProviderV2 } from "@newhorse/core/provider"
import { SessionV1 } from "@newhorse/core/v1/session"
import { SessionStatusEvent } from "@newhorse/schema/session-status-event"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Effect, Layer, Context, Scope, Option } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionPrompt } from "./prompt"
import { SessionRunState } from "./run-state"
import { Todo } from "./todo"

/**
 * Todo continuation enforcer ("bouldering mode").
 *
 * Subscribes to the per-session idle event and, when a main session goes idle
 * with open (not completed/cancelled) todos, re-injects a synthetic continue
 * prompt through `SessionPrompt.prompt` — same agent, same model — so the
 * agent keeps working until its task list is resolved.
 *
 * Original implementation for newhorse (pattern reference: oh-my-opencode's
 * todo-continuation enforcer; SUL-1.0 licensed source is not copied).
 */

const ABORT_COOLDOWN_MS = 3_000
/** Aborted assistant messages carry this error name (see SessionV1.AbortedError). */
const ABORTED_ERROR_NAME = "MessageAbortedError"

/** Statuses that count as an open (unfinished) todo. */
export function isOpenTodoStatus(status: string): boolean {
  return status !== "completed" && status !== "cancelled"
}

/** True when at least one todo is still open. */
export function hasIncompleteTodos(todos: readonly Todo.Info[]): boolean {
  return todos.some((todo) => isOpenTodoStatus(todo.status))
}

/** Completed/total counts used for the `[Status: X/Y completed]` progress line. */
export function todoProgress(todos: readonly Todo.Info[]): { completed: number; total: number } {
  let completed = 0
  for (const todo of todos) if (todo.status === "completed") completed++
  return { completed, total: todos.length }
}

/**
 * Read-only agents (edit AND write denied for `*`) cannot act on a task list,
 * so a continue prompt would just spin. Unknown agents are treated as
 * read-only (skip) to stay safe.
 */
export function isReadOnlyAgent(
  agent: Agent.Info | undefined,
  sessionPermission: PermissionV1.Ruleset | undefined,
): boolean {
  if (!agent) return true
  const ruleset = Agent.effectivePermission(agent, sessionPermission ?? [])
  return (
    Permission.evaluate("edit", "*", ruleset).action === "deny" &&
    Permission.evaluate("write", "*", ruleset).action === "deny"
  )
}

/** Mirrors Session.cancelBackgroundJobs: running jobs owned by this session block continuation. */
export function hasRunningBackgroundJobs(jobs: readonly BackgroundJob.Info[], sessionID: SessionID): boolean {
  return jobs.some(
    (job) =>
      job.status === "running" &&
      (job.id === sessionID || job.metadata?.sessionId === sessionID || job.metadata?.parentSessionId === sessionID),
  )
}

export type Decision = {
  readonly agent: string
  readonly model: { providerID: ProviderV2.ID; modelID: ModelV2.ID; variant?: string }
  readonly progress: { completed: number; total: number }
  readonly open: readonly Todo.Info[]
}

export type DecideInput = {
  readonly sessionID: SessionID
  readonly parentID: Session.Info["parentID"]
  readonly permission: Session.Info["permission"]
  readonly todos: readonly Todo.Info[]
  readonly lastUser: SessionV1.User | undefined
  readonly agent: Agent.Info | undefined
  readonly jobs: readonly BackgroundJob.Info[]
  readonly lastAbort: number
  readonly now: number
}

/**
 * Pure trigger-condition check. Returns a `Decision` to inject a continue
 * prompt, or `undefined` to stay idle. All guards must pass:
 *   1. main session only (no parent)
 *   2. at least one open todo
 *   3. we know which agent/model was active (last user message)
 *   4. not a hidden agent (compaction/title/summary)
 *   5. not read-only (edit/write denied)
 *   6. no running background job owned by the session
 *   7. no abort in the last ABORT_COOLDOWN_MS
 */
export function decisionFor(input: DecideInput): Decision | undefined {
  if (input.parentID) return
  if (!hasIncompleteTodos(input.todos)) return
  if (!input.lastUser) return
  if (!input.agent || input.agent.hidden) return
  if (isReadOnlyAgent(input.agent, input.permission)) return
  if (hasRunningBackgroundJobs(input.jobs, input.sessionID)) return
  if (input.now - input.lastAbort < ABORT_COOLDOWN_MS) return
  return {
    agent: input.lastUser.agent,
    model: {
      providerID: input.lastUser.model.providerID,
      modelID: input.lastUser.model.modelID,
      ...(input.lastUser.model.variant ? { variant: input.lastUser.model.variant } : {}),
    },
    progress: todoProgress(input.todos),
    open: input.todos.filter((todo) => isOpenTodoStatus(todo.status)),
  }
}

/** Self-written continue prompt (product voice: terse, directive, no copied prose). */
export function continuationPrompt(input: {
  progress: { completed: number; total: number }
  open: readonly Todo.Info[]
}): string {
  const { completed, total } = input.progress
  const remaining = total - completed
  const lines = input.open.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`).join("\n")
  return [
    "[Todo continuation]",
    "",
    `The last turn ended with ${remaining} open task${remaining === 1 ? "" : "s"} remaining. Resume working on them now.`,
    "",
    `[Status: ${completed}/${total} completed]`,
    "",
    "Open tasks:",
    lines,
    "",
    "Work through each open task until it is completed or cancelled. Update the task list with",
    "the todo tools as you make progress. Do not stop early and do not ask for permission to",
    "resume — continue directly.",
  ].join("\n")
}

export interface Interface {
  /** Evaluates every trigger condition for a session; `undefined` means no injection. */
  readonly evaluate: (sessionID: SessionID) => Effect.Effect<Decision | undefined>
  /** Injects a synthetic continue prompt (runs the session loop). */
  readonly inject: (sessionID: SessionID, decision: Decision) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/TodoContinuation") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const todo = yield* Todo.Service
    const agents = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const prompt = yield* SessionPrompt.Service
    const runState = yield* SessionRunState.Service
    const scope = yield* Scope.Scope

    const recovering = new Set<SessionID>()
    const lastAbortTimes = new Map<SessionID, number>()

    const isIdle = (event: EventV2.Payload): event is EventV2.Payload<typeof SessionStatusEvent.Idle> =>
      event.type === SessionStatusEvent.Idle.type

    const isSessionError = (event: EventV2.Payload): event is EventV2.Payload<typeof SessionV1.Event.Error> =>
      event.type === SessionV1.Event.Error.type

    const evaluate = Effect.fn("TodoContinuation.evaluate")(function* (sessionID: SessionID) {
      const now = Date.now()
      // Prune abort marks that no longer gate anything so the map stays bounded.
      for (const [id, ts] of lastAbortTimes) {
        if (now - ts >= ABORT_COOLDOWN_MS) lastAbortTimes.delete(id)
      }

      const session = yield* sessions.get(sessionID).pipe(Effect.option)
      if (Option.isNone(session)) return

      const todos = yield* todo.get(sessionID)
      if (!hasIncompleteTodos(todos)) return

      const lastUserOption = yield* sessions
        .findMessage(sessionID, (message) => message.info.role === "user")
        .pipe(Effect.orDie)
      if (Option.isNone(lastUserOption)) return
      const lastUser = lastUserOption.value.info
      if (lastUser.role !== "user") return

      const agent = yield* agents.get(lastUser.agent)

      const jobs = yield* background.list()

      // Don't inject into a session a human is actively driving.
      const notBusy = yield* runState.assertNotBusy(sessionID).pipe(Effect.option)
      if (Option.isNone(notBusy)) return

      return decisionFor({
        sessionID,
        parentID: session.value.parentID,
        permission: session.value.permission,
        todos,
        lastUser,
        agent,
        jobs,
        lastAbort: lastAbortTimes.get(sessionID) ?? 0,
        now,
      })
    })

    const inject = Effect.fn("TodoContinuation.inject")(function* (sessionID: SessionID, decision: Decision) {
      yield* Effect.logInfo("todo-continuation resuming session", {
        "session.id": sessionID,
        agent: decision.agent,
        completed: decision.progress.completed,
        total: decision.progress.total,
      })
      yield* prompt
        .prompt({
          sessionID,
          agent: decision.agent,
          model: { providerID: decision.model.providerID, modelID: decision.model.modelID },
          ...(decision.model.variant ? { variant: decision.model.variant } : {}),
          parts: [
            {
              type: "text",
              text: continuationPrompt({ progress: decision.progress, open: decision.open }),
              synthetic: true,
            },
          ],
        })
        .pipe(Effect.catch((error) => Effect.logError("todo-continuation injection failed", { error })))
    })

    const handleIdle = Effect.fn("TodoContinuation.handleIdle")(function* (sessionID: SessionID) {
      // The idle that ends a previous injected run lifts the suppression marker;
      // only then may we re-inject (bouldering continues while todos stay open).
      if (recovering.has(sessionID)) recovering.delete(sessionID)

      const decision = yield* evaluate(sessionID)
      if (!decision) return

      recovering.add(sessionID)
      yield* inject(sessionID, decision).pipe(Effect.forkIn(scope))
    })

    const unsubscribeError = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (!isSessionError(event)) return
        const sessionID = event.data.sessionID
        if (!sessionID) return
        if (!event.data.error || event.data.error.name !== ABORTED_ERROR_NAME) return
        yield* Effect.sync(() => lastAbortTimes.set(sessionID, Date.now()))
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("todo-continuation error handler failed", { cause })),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribeError)

    const unsubscribeIdle = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (!isIdle(event)) return
        yield* handleIdle(event.data.sessionID)
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("todo-continuation idle handler failed", { cause })),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribeIdle)

    return Service.of({ evaluate, inject })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    EventV2Bridge.node,
    Session.node,
    Todo.node,
    Agent.node,
    BackgroundJob.node,
    SessionPrompt.node,
    SessionRunState.node,
  ],
})

export * as TodoContinuation from "./todo-continuation"

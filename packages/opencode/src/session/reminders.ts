import path from "path"
import { SessionV1 } from "@newhorse/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@newhorse/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { BoulderState } from "@/plan/boulder-state"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    let resume = ""
    if (exists) {
      // boulder-state: a build agent taking over an active plan resumes it with
      // cross-session progress. A fully-ticked plan clears the state instead.
      const state = yield* BoulderState.getState(ctx)
      if (state && state.active_plan === plan) {
        const progress = yield* BoulderState.getPlanProgress(plan)
        if (progress.isComplete) {
          yield* BoulderState.clearState(ctx)
        } else {
          yield* BoulderState.appendSessionId(ctx, input.session.id)
          resume = "\n\n" + BoulderState.resumePrompt({
            planPath: plan,
            planName: state.plan_name,
            startedAt: state.started_at,
            progress,
          })
        }
      }
    }
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it${resume}`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan") {
    // Build agent continuing build work: once the active plan is fully ticked
    // off, drop its boulder state so a later session doesn't resume a finished plan.
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const state = yield* BoulderState.getState(ctx)
    if (state && state.active_plan === plan) {
      const progress = yield* BoulderState.getPlanProgress(plan)
      if (progress.isComplete) yield* BoulderState.clearState(ctx)
    }
    return input.messages
  }

  if (assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))

  // boulder-state: once a plan file exists, record it as the active plan so a
  // later build agent can pick it up across sessions.
  if (exists) {
    const state = yield* BoulderState.getState(ctx)
    if (state?.active_plan === plan) {
      yield* BoulderState.appendSessionId(ctx, input.session.id)
    } else {
      yield* BoulderState.createState(ctx, {
        activePlan: plan,
        planName: BoulderState.planName(plan),
        sessionID: input.session.id,
      })
    }
  }

  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"

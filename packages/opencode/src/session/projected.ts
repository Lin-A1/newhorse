import { Schema, Types } from "effect"
import { SessionV1 } from "@newhorse/core/v1/session"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { Database } from "@newhorse/core/database/database"
import { SessionID } from "./schema"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { Provider } from "@/provider/provider"
import { serviceUse } from "@newhorse/core/effect/service-use"
import type { Provider as ProviderType } from "@/provider/provider"

export const ProjectedTokens = Schema.Struct({
  nextInput: Schema.Finite,
  nextOutput: Schema.Finite,
  nextCost: Schema.Finite,
  contextWindow: Schema.Finite,
}).annotate({ identifier: "SessionProjectedTokens" })
export type ProjectedTokens = Types.DeepMutable<Schema.Schema.Type<typeof ProjectedTokens>>

export const ContextBreakdown = Schema.Struct({
  system: Schema.Finite,
  tools: Schema.Finite,
  messages: Schema.Finite,
}).annotate({ identifier: "SessionContextBreakdown" })
export type ContextBreakdown = Types.DeepMutable<Schema.Schema.Type<typeof ContextBreakdown>>

export const ContextPressure = Schema.Struct({
  pressure: Schema.Finite,
  projected: Schema.Finite,
  window: Schema.Finite,
}).annotate({ identifier: "SessionContextPressure" })
export type ContextPressure = Types.DeepMutable<Schema.Schema.Type<typeof ContextPressure>>

/** Projection of the next provider request for the session: token footprint
 * and cost estimate. Everything here is a heuristic, never a billing quote. */
export const Info = Schema.Struct({
  projectedTokens: ProjectedTokens,
  contextBreakdown: ContextBreakdown,
  contextPressure: ContextPressure,
}).annotate({ identifier: "SessionProjected" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const empty = (): Info => ({
  projectedTokens: { nextInput: 0, nextOutput: 0, nextCost: 0, contextWindow: 0 },
  contextBreakdown: { system: 0, tools: 0, messages: 0 },
  contextPressure: { pressure: 0, projected: 0, window: 0 },
})

const clamp = (value: number, min: number, max?: number) => {
  const lower = Math.max(min, value)
  return max !== undefined && max > 0 ? Math.min(max, lower) : lower
}

const costTier = (cost: ProviderType.Model["cost"] | undefined, contextTokens: number) => {
  if (!cost) return cost
  return (
    cost.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (cost.experimentalOver200K && contextTokens > 200_000 ? cost.experimentalOver200K : cost)
  )
}

const safe = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

const percent = (part: number, window: number) => {
  if (window <= 0 || part <= 0) return 0
  return Math.round((Math.min(part, window) / window) * 1000) / 10
}

// Heuristic surface growth for the next turn. The assistant's output is echoed
// back into the input on the next request, but the baseline already includes
// every past turn's output, so the marginal addition is roughly one turn of
// output (plus a small allowance for tool results). The old 1.35x multiplier
// double-counted history and made "projected" jump far ahead of "used" on
// long sessions.
const growthFor = (output: number) => Math.round(output * 1.1)

export function estimate(input: {
  /** tokens occupying the window on the most recent request (input + cache read + cache write) */
  context: number
  /** input tokens served from prompt cache on the most recent request */
  contextRead: number
  /** output + reasoning tokens of the most recent assistant turn */
  recentOutput: number
  /** cumulative output + reasoning tokens across the session */
  totalOutput: number
  /** user-turn estimate for the session */
  turns: number
  /** estimated characters of the system prompt plus tool schemas, per bucket */
  surfaceChars: { system: number; tools: number; messages: number }
  contextWindow?: number
  outputLimit?: number
  cost?: ProviderType.Model["cost"] | undefined
}): Info {
  const window = safe(input.contextWindow)
  const outputLimit = safe(input.outputLimit)
  // Prefer the most recent turn's output as the next-turn baseline: a session's
  // historical average can be inflated by early huge turns and makes the
  // projection diverge from the current footprint.
  const baseOutput = input.recentOutput > 0 ? input.recentOutput : input.turns > 0 ? input.totalOutput / input.turns : 0
  const nextOutput = baseOutput > 0 ? clamp(Math.round(baseOutput), 128, outputLimit || undefined) : 0

  const systemTokens = Math.ceil(input.surfaceChars.system / 4)
  // A session that has not produced a request yet still pays for the system
  // prompt on its first turn, so project from that baseline.
  const baseline = Math.max(input.context, systemTokens)
  // The next request only *adds* the marginal delta on top of the current
  // footprint: cache-read tokens are already part of `context` and are served
  // from cache again, so growth is the fresh input plus output echo.
  const nextInput = Math.round(
    window > 0
      ? Math.min(baseline + growthFor(nextOutput), window)
      : baseline + growthFor(nextOutput),
  )

  const tier = costTier(input.cost, nextInput)
  const freshInput = Math.max(0, nextInput - input.contextRead)
  const nextCost = safe(
    (freshInput * (tier?.input ?? 0) +
      input.contextRead * (tier?.cache?.read ?? 0) +
      nextOutput * (tier?.output ?? 0)) /
      1_000_000,
  )

  const raw = {
    system: Math.ceil(input.surfaceChars.system / 4),
    tools: Math.ceil(input.surfaceChars.tools / 4),
    messages: Math.ceil(input.surfaceChars.messages / 4),
  }
  const rawTotal = raw.system + raw.tools + raw.messages
  const budget = safe(input.context)
  const contextBreakdown: ContextBreakdown =
    budget === 0
      ? { system: 0, tools: 0, messages: 0 }
      : rawTotal <= budget
        ? { ...raw, messages: raw.messages + (budget - rawTotal) }
        : rawTotal > 0
          ? (() => {
              const scale = budget / rawTotal
              const system = Math.floor(raw.system * scale)
              const tools = Math.floor(raw.tools * scale)
              return { system, tools, messages: budget - system - tools }
            })()
          : { system: 0, tools: 0, messages: budget }

  return {
    projectedTokens: {
      nextInput,
      nextOutput,
      nextCost,
      contextWindow: window,
    },
    contextBreakdown,
    contextPressure: {
      pressure: percent(safe(input.context), window),
      projected: percent(nextInput, window),
      window,
    },
  }
}

type Surface = {
  turns: number
  systemChars: number
  toolsChars: number
  messagesChars: number
  recent: {
    context: number
    contextRead: number
    output: number
  } | undefined
}

const toolChars = (part: Extract<SessionV1.Part, { type: "tool" }>) => {
  const input = Object.keys(part.state.input).length * 16
  const state = part.state
  if (state.status === "completed") return input + state.output.length
  if (state.status === "error") return input + state.error.length
  if (state.status === "pending") return input + state.raw.length
  return input
}

const userChars = (part: SessionV1.Part) => {
  if (part.type === "text") return part.text.length
  if (part.type === "file") return part.source?.text.value.length ?? 0
  if (part.type === "agent") return part.source?.value.length ?? 0
  return 0
}

/** Cheap character-level surface estimate of the current context, mirroring
 * the app's local breakdown so server and client agree on magnitudes. */
export function surface(items: SessionV1.WithParts[], systemFrom?: string): Surface {
  let turns = 0
  let systemChars = systemFrom?.length ?? 0
  let toolsChars = 0
  let messagesChars = 0
  let recent: Surface["recent"]

  for (const item of items) {
    const info = item.info
    if (info.role === "user") {
      turns += 1
      messagesChars += item.parts.reduce((sum, part) => sum + userChars(part), 0)
      continue
    }
    if (info.role !== "assistant") continue

    const tokens = (info as SessionV1.Assistant).tokens
    if (
      tokens &&
      (tokens.input > 0 || tokens.output > 0 || tokens.reasoning > 0 || tokens.cache.read > 0 || tokens.cache.write > 0)
    ) {
      recent = {
        context: tokens.input + tokens.cache.read + tokens.cache.write,
        contextRead: tokens.cache.read,
        output: tokens.output + tokens.reasoning,
      }
    }
    for (const part of item.parts) {
      if (part.type === "tool") {
        toolsChars += toolChars(part)
        continue
      }
      if (part.type === "text" || part.type === "reasoning") messagesChars += part.text.length
    }
  }

  return { turns, systemChars, toolsChars, messagesChars, recent }
}

export function estimateFrom(items: SessionV1.WithParts[], input: {
  systemFrom?: string
  totalOutput: number
  contextWindow?: number
  outputLimit?: number
  cost?: ProviderType.Model["cost"] | undefined
}): Info {
  const surfaceInfo = surface(items, input.systemFrom)
  const recent = surfaceInfo.recent ?? { context: 0, contextRead: 0, output: 0 }
  return estimate({
    context: recent.context,
    contextRead: recent.contextRead,
    recentOutput: recent.output,
    totalOutput: input.totalOutput,
    turns: surfaceInfo.turns,
    surfaceChars: {
      system: surfaceInfo.systemChars,
      tools: surfaceInfo.toolsChars,
      messages: surfaceInfo.messagesChars,
    },
    contextWindow: input.contextWindow,
    outputLimit: input.outputLimit,
    cost: input.cost,
  })
}

export interface Interface {
  readonly projected: (sessionID: SessionID) => Effect.Effect<Info, Session.NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/SessionProjected") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service

    const projected = Effect.fn("SessionProjected.projected")(function* (sessionID: SessionID) {
      const info = yield* sessions.get(sessionID)
      if (!info.model) return empty()

      const model = yield* provider
        .getModel(info.model.providerID, info.model.id)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))

      const page = yield* MessageV2.page({ sessionID, limit: 40 })
        .pipe(Effect.provideService(Database.Service, database))
        .pipe(Effect.orDie)
      const systemFrom = page.items
        .filter((item): item is SessionV1.WithParts & { info: SessionV1.User } => item.info.role === "user")
        .at(-1)?.info.system

      return estimateFrom(page.items, {
        systemFrom,
        totalOutput: info.tokens ? info.tokens.output + info.tokens.reasoning : 0,
        contextWindow: model?.limit.context,
        outputLimit: model?.limit.output,
        cost: model?.cost,
      })
    })

    return Service.of({ projected })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node, Session.node, Provider.node, MessageV2.node],
})

export * as Projected from "./projected"
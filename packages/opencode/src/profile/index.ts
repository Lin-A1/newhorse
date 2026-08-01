import { ConfigProfileV1 } from "@newhorse/core/v1/config/profile"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { serviceUse } from "@newhorse/core/effect/service-use"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "@/config/config"

export const ID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)).pipe(
  Schema.brand("Profile.ID"),
)
export type ID = Schema.Schema.Type<typeof ID>

export const Info = Schema.Struct({
  id: ID,
  kind: ConfigProfileV1.Kind,
  name: Schema.String,
  memory: ConfigProfileV1.MemoryPolicy,
  proactive: Schema.Boolean,
})
export type Info = Schema.Schema.Type<typeof Info>

export const Runtime = Schema.Struct({
  id: ID,
  kind: ConfigProfileV1.Kind,
  name: Schema.String,
  persona: Schema.optional(Schema.String),
  personaVersion: Schema.Int,
  memory: ConfigProfileV1.MemoryPolicy,
  proactive: Schema.Boolean,
  proactivePaused: Schema.Boolean,
  quietHours: Schema.optional(ConfigProfileV1.QuietHours),
  proactiveFrequency: ConfigProfileV1.ProactiveFrequency,
  crisisRegion: Schema.optional(Schema.String),
})
export type Runtime = Schema.Schema.Type<typeof Runtime>

export const Update = Schema.Struct({
  name: Schema.optional(Schema.String),
  persona: Schema.optional(Schema.String),
  memory: Schema.optional(ConfigProfileV1.MemoryPolicy),
  proactive: Schema.optional(Schema.Boolean),
  proactivePaused: Schema.optional(Schema.Boolean),
  quietHours: Schema.optional(ConfigProfileV1.QuietHours),
  proactiveFrequency: Schema.optional(ConfigProfileV1.ProactiveFrequency),
  crisisRegion: Schema.optional(Schema.String),
})
export type Update = Schema.Schema.Type<typeof Update>

export const Setup = Schema.Struct({
  id: ID,
  update: Update,
  activate: Schema.Boolean,
})
export type Setup = Schema.Schema.Type<typeof Setup>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ProfileNotFoundError", {
  profileID: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id?: ID) => Effect.Effect<Info, NotFoundError>
  readonly runtime: (id?: ID) => Effect.Effect<Runtime, NotFoundError>
  readonly activeID: () => Effect.Effect<ID>
  readonly select: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly update: (id: ID, input: Update) => Effect.Effect<Runtime, NotFoundError>
  readonly setup: (input: Setup) => Effect.Effect<Runtime, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Profile") {}

export const use = serviceUse(Service)

const DEFAULT_ID = "assistant"
const COMPANION_ID = "companion"
const DEFAULT_PROFILE: Info = {
  id: ID.make(DEFAULT_ID),
  kind: "assistant",
  name: "Assistant",
  memory: "ask",
  proactive: false,
}
const DEFAULT_COMPANION: ConfigProfileV1.Item = {
  kind: "companion",
  name: "Companion",
  personaVersion: 1,
  memory: "ask",
  proactive: false,
}

function publicInfo(id: string, item: ConfigProfileV1.Item): Info {
  return {
    id: ID.make(id),
    kind: item.kind,
    name: item.name?.trim() || (item.kind === "companion" ? "Companion" : "Assistant"),
    memory: item.memory ?? "ask",
    proactive: item.proactive ?? false,
  }
}

function runtimeInfo(id: string, item: ConfigProfileV1.Item): Runtime {
  const info = publicInfo(id, item)
  return {
    ...info,
    persona: item.persona?.trim() || undefined,
    personaVersion: item.personaVersion ?? 1,
    proactivePaused: item.proactivePaused ?? false,
    quietHours: item.quietHours,
    proactiveFrequency: item.proactiveFrequency ?? { maxPerDay: 3, minIntervalMinutes: 120 },
    crisisRegion: item.crisisRegion?.trim() || undefined,
  }
}

function configured(global: ConfigProfileV1.Info | undefined): Record<string, ConfigProfileV1.Item | undefined> {
  return {
    [COMPANION_ID]: DEFAULT_COMPANION,
    ...global?.items,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const items = Effect.fn("Profile.items")(function* () {
      const global = yield* config.getGlobal()
      const entries = Object.entries(configured(global.profile))
        .filter((entry): entry is [string, ConfigProfileV1.Item] => Schema.is(ID)(entry[0]) && entry[1] !== undefined)
        .map(([id, item]) => publicInfo(id, item))
      if (!entries.some((item) => item.id === DEFAULT_ID)) entries.unshift(DEFAULT_PROFILE)
      return entries
    })

    const activeID = Effect.fn("Profile.activeID")(function* () {
      const global = yield* config.getGlobal()
      const requested = global.profile?.active
      const available = yield* items()
      return available.some((item) => item.id === requested) ? ID.make(requested!) : ID.make(DEFAULT_ID)
    })

    const get = Effect.fn("Profile.get")(function* (id?: ID) {
      const profileID = id ?? (yield* activeID())
      const result = (yield* items()).find((item) => item.id === profileID)
      if (result) return result
      return yield* new NotFoundError({ profileID, message: `Profile not found: ${profileID}` })
    })

    const runtime = Effect.fn("Profile.runtime")(function* (id?: ID) {
      const profileID = id ?? (yield* activeID())
      const global = yield* config.getGlobal()
      const item = configured(global.profile)[profileID]
      if (item) return runtimeInfo(profileID, item)
      if (profileID === DEFAULT_ID) {
        return runtimeInfo(DEFAULT_ID, { kind: "assistant", name: DEFAULT_PROFILE.name })
      }
      return yield* new NotFoundError({ profileID, message: `Profile not found: ${profileID}` })
    })

    const select = Effect.fn("Profile.select")(function* (id: ID) {
      const selected = yield* get(id)
      yield* config.updateGlobal({ profile: { active: selected.id } })
      return selected
    })

    const nextItem = (current: Runtime, previous: ConfigProfileV1.Item, input: Update): ConfigProfileV1.Item => {
      const persona = input.persona?.trim() || undefined
      return {
        ...previous,
        name: input.name?.trim() || current.name,
        persona: input.persona === undefined ? previous.persona : persona || undefined,
        personaVersion:
          input.persona === undefined || persona === current.persona
            ? current.personaVersion
            : current.personaVersion + 1,
        memory: input.memory ?? current.memory,
        proactive: input.proactive ?? current.proactive,
        proactivePaused: input.proactivePaused ?? current.proactivePaused,
        quietHours: input.quietHours ?? previous.quietHours,
        proactiveFrequency: input.proactiveFrequency ?? current.proactiveFrequency,
        crisisRegion: input.crisisRegion === undefined ? previous.crisisRegion : input.crisisRegion.trim() || undefined,
      }
    }

    const update = Effect.fn("Profile.update")(function* (id: ID, input: Update) {
      const current = yield* runtime(id)
      const global = yield* config.getGlobal()
      const previous = configured(global.profile)[id] ?? { kind: current.kind }
      const next = nextItem(current, previous, input)
      yield* config.updateGlobal({ profile: { items: { [id]: next } } })
      return runtimeInfo(id, next)
    })

    const setup = Effect.fn("Profile.setup")(function* (input: Setup) {
      const current = yield* runtime(input.id)
      const global = yield* config.getGlobal()
      const previous = configured(global.profile)[input.id] ?? { kind: current.kind }
      const next = nextItem(current, previous, input.update)
      yield* config.updateGlobal({
        profile: {
          ...(input.activate ? { active: input.id } : {}),
          items: { [input.id]: next },
        },
      })
      return runtimeInfo(input.id, next)
    })

    return Service.of({ list: items, get, runtime, activeID, select, update, setup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node],
})

export * as Profile from "./index"

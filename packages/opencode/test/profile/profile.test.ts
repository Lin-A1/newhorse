import { expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { ConfigV1 } from "@newhorse/core/v1/config/config"
import { Effect, Layer, Ref } from "effect"
import { Config } from "@/config/config"
import { Profile } from "@/profile"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

function profileLayer(initial: ConfigV1.Info = {}) {
  const state = Ref.makeUnsafe(initial)
  const config = TestConfig.make({
    getGlobal: () => Ref.get(state),
    updateGlobal: (patch) =>
      Ref.updateAndGet(state, (current) => ({
        ...current,
        profile: {
          ...current.profile,
          ...patch.profile,
        },
      })).pipe(Effect.map((info) => ({ info, changed: true }))),
  })
  return LayerNode.compile(Profile.node, [[Config.node, Layer.succeed(Config.Service, config)]])
}

const it = (config?: ConfigV1.Info) => testEffect(profileLayer(config))
const assistantID = Profile.ID.make("assistant")
const companionID = Profile.ID.make("companion")

it().effect("provides a safe default assistant profile", () =>
  Effect.gen(function* () {
    const profile = yield* Profile.Service

    expect(yield* profile.activeID()).toBe(assistantID)
    expect(yield* profile.get()).toEqual({
      id: assistantID,
      kind: "assistant",
      name: "Assistant",
      memory: "ask",
      proactive: false,
    })
  }),
)

it({
  profile: {
    active: "companion",
    items: {
      companion: {
        kind: "companion",
        name: "Anchor",
        persona: "private persona instructions",
        memory: "auto-safe",
        proactive: true,
      },
    },
  },
}).effect("returns redacted profiles and persists selection", () =>
  Effect.gen(function* () {
    const profile = yield* Profile.Service

    expect(yield* profile.get()).toEqual({
      id: companionID,
      kind: "companion",
      name: "Anchor",
      memory: "auto-safe",
      proactive: true,
    })
    expect(JSON.stringify(yield* profile.list())).not.toContain("private persona instructions")

    yield* profile.select(assistantID)
    expect(yield* profile.activeID()).toBe(assistantID)
  }),
)

it().effect("updates companion runtime and only bumps changed persona versions", () =>
  Effect.gen(function* () {
    const profile = yield* Profile.Service

    const first = yield* profile.update(companionID, {
      persona: "Warm and concise",
      memory: "auto-safe",
      crisisRegion: "CN",
    })
    expect(first).toMatchObject({
      id: companionID,
      kind: "companion",
      persona: "Warm and concise",
      personaVersion: 2,
      memory: "auto-safe",
      proactive: false,
      crisisRegion: "CN",
    })

    const unchanged = yield* profile.update(companionID, { persona: "Warm and concise" })
    expect(unchanged.personaVersion).toBe(2)

    const changed = yield* profile.update(companionID, { persona: "Calm and direct" })
    expect(changed.personaVersion).toBe(3)
  }),
)

it().effect("sets up and activates a profile with one global patch", () =>
  Effect.gen(function* () {
    const profile = yield* Profile.Service
    const result = yield* profile.setup({
      id: assistantID,
      update: { name: "Newhorse Assistant", persona: "Direct and practical", memory: "auto-safe" },
      activate: true,
    })

    expect(result).toMatchObject({
      id: assistantID,
      name: "Newhorse Assistant",
      persona: "Direct and practical",
      personaVersion: 2,
      memory: "auto-safe",
    })
    expect(yield* profile.activeID()).toBe(assistantID)
    expect(yield* profile.runtime(assistantID)).toMatchObject(result)
  }),
)

it().effect("rejects unknown profile selection", () =>
  Effect.gen(function* () {
    const profile = yield* Profile.Service
    const exit = yield* profile.select(Profile.ID.make("missing")).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)

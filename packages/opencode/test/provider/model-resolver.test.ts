import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ProviderV2 } from "@newhorse/core/provider"
import { ModelV2 } from "@newhorse/core/model"
import { ConfigV1 } from "@newhorse/core/v1/config/config"
import { ConfigAgentV1 } from "@newhorse/core/v1/config/agent"
import { Provider } from "@/provider/provider"
import { resolveWithFallback, fallbackChainForAgent } from "@/provider/model-resolver"

function model(providerID: string, modelID: string): Provider.Model {
  return {
    id: ModelV2.ID.make(modelID),
    providerID: ProviderV2.ID.make(providerID),
    api: { id: modelID, url: "", npm: "@ai-sdk/openai-compatible" },
    name: modelID,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  }
}

function providerInfo(providerID: string, modelIDs: string[]): Provider.Info {
  return {
    id: ProviderV2.ID.make(providerID),
    name: providerID,
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(modelIDs.map((id) => [id, model(providerID, id)])),
  }
}

const providersOf = (record: Record<string, Provider.Info>) =>
  record as Record<ProviderV2.ID, Provider.Info>

function mockProvider(record: Record<string, Provider.Info>): Provider.Interface {
  const providers = providersOf(record)
  return {
    list: () => Effect.succeed(providers),
    getProvider: (providerID) => Effect.succeed(providers[providerID]),
    getModel: (providerID, modelID) => {
      const info = providers[providerID]
      if (!info?.models[modelID]) return Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
      return Effect.succeed(info.models[modelID])
    },
    getLanguage: () => Effect.die(new Error("unused")),
    closest: () => Effect.succeed(undefined),
    getSmallModel: () => Effect.succeed(undefined),
    defaultModel: () =>
      Effect.succeed({ providerID: ProviderV2.ID.make("mock-default"), modelID: ModelV2.ID.make("default-model") }),
  }
}

const openaiDefault = {
  providerID: ProviderV2.ID.make("openai"),
  modelID: ModelV2.ID.make("gpt-5"),
}

describe("resolveWithFallback", () => {
  test("explicit override wins without an availability check", () => {
    const provider = mockProvider({})
    const result = Effect.runSync(
      resolveWithFallback(provider, {
        explicit: { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude-sonnet") },
        fallbackChain: [{ providers: ["openrouter"], model: "claude-sonnet" }],
        defaultModel: Effect.succeed(openaiDefault),
      }),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("anthropic"),
      modelID: ModelV2.ID.make("claude-sonnet"),
      variant: undefined,
      source: "override",
    })
  })

  test("skips an unavailable primary provider and falls back to the next", () => {
    const provider = mockProvider({
      openrouter: providerInfo("openrouter", ["claude-sonnet"]),
    })
    const result = Effect.runSync(
      resolveWithFallback(provider, {
        fallbackChain: [
          { providers: ["anthropic", "openrouter"], model: "claude-sonnet", variant: "thinking" },
        ],
        defaultModel: Effect.succeed(openaiDefault),
      }),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("openrouter"),
      modelID: ModelV2.ID.make("claude-sonnet"),
      variant: "thinking",
      source: "fallback",
    })
  })

  test("within an entry the first connected provider wins", () => {
    const provider = mockProvider({
      anthropic: providerInfo("anthropic", ["claude-sonnet"]),
    })
    const result = Effect.runSync(
      resolveWithFallback(provider, {
        fallbackChain: [{ providers: ["anthropic", "openrouter"], model: "claude-sonnet" }],
        defaultModel: Effect.succeed(openaiDefault),
      }),
    )
    expect(result.providerID).toBe(ProviderV2.ID.make("anthropic"))
    expect(result.source).toBe("fallback")
  })

  test("skips a connected provider that does not expose the model", () => {
    const provider = mockProvider({
      anthropic: providerInfo("anthropic", ["claude-opus"]),
      openrouter: providerInfo("openrouter", ["claude-sonnet"]),
    })
    const result = Effect.runSync(
      resolveWithFallback(provider, {
        fallbackChain: [{ providers: ["anthropic", "openrouter"], model: "claude-sonnet" }],
        defaultModel: Effect.succeed(openaiDefault),
      }),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("openrouter"),
      modelID: ModelV2.ID.make("claude-sonnet"),
      variant: undefined,
      source: "fallback",
    })
  })

  test("tries the next chain entry when the whole first entry is unavailable", () => {
    const provider = mockProvider({
      openai: providerInfo("openai", ["gpt-5"]),
    })
    const result = Effect.runSync(
      resolveWithFallback(provider, {
        fallbackChain: [
          { providers: ["anthropic"], model: "claude-sonnet" },
          { providers: ["openai"], model: "gpt-5", variant: "high" },
        ],
        defaultModel: Effect.succeed(openaiDefault),
      }),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("openai"),
      modelID: ModelV2.ID.make("gpt-5"),
      variant: "high",
      source: "fallback",
    })
  })

  test("falls back to the default when the whole chain is unavailable", () => {
    const provider = mockProvider({})
    const result = Effect.runSync(
      resolveWithFallback(provider, {
        fallbackChain: [
          { providers: ["anthropic"], model: "claude-sonnet" },
          { providers: ["openrouter"], model: "claude-sonnet" },
        ],
        defaultModel: Effect.succeed(openaiDefault),
      }),
    )
    expect(result).toEqual({ ...openaiDefault, variant: undefined, source: "default" })
  })

  test("resolves straight to the default when no fallback chain is configured", () => {
    const provider = mockProvider({
      anthropic: providerInfo("anthropic", ["claude-sonnet"]),
    })
    const result = Effect.runSync(
      resolveWithFallback(provider, {
        defaultModel: Effect.succeed(openaiDefault),
      }),
    )
    expect(result).toEqual({ ...openaiDefault, variant: undefined, source: "default" })
  })

  test("defaultModel is only evaluated when the chain is exhausted", () => {
    const provider = mockProvider({})
    let evaluated = false
    const result = Effect.runSync(
      resolveWithFallback(provider, {
        fallbackChain: [{ providers: ["anthropic"], model: "claude-sonnet" }],
        defaultModel: Effect.sync(() => {
          evaluated = true
          return openaiDefault
        }),
      }),
    )
    expect(evaluated).toBe(true)
    expect(result.source).toBe("default")
  })

  test("defaultModel is not evaluated when an explicit override wins", () => {
    const provider = mockProvider({})
    let evaluated = false
    const result = Effect.runSync(
      resolveWithFallback(provider, {
        explicit: { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude-sonnet") },
        fallbackChain: [{ providers: ["anthropic"], model: "claude-sonnet" }],
        defaultModel: Effect.sync(() => {
          evaluated = true
          return openaiDefault
        }),
      }),
    )
    expect(evaluated).toBe(false)
    expect(result.source).toBe("override")
  })
})

describe("fallbackChainForAgent", () => {
  test("reads the agent's fallback chain from the v1 config", () => {
    const config = {
      agent: {
        build: {
          fallbackChain: [{ providers: ["anthropic", "openrouter"], model: "claude-sonnet" }],
        },
      },
    } as ConfigV1.Info
    expect(fallbackChainForAgent(config, "build")).toEqual([
      { providers: ["anthropic", "openrouter"], model: "claude-sonnet" },
    ])
    expect(fallbackChainForAgent(config, "missing")).toBeUndefined()
    expect(fallbackChainForAgent({} as ConfigV1.Info, "build")).toBeUndefined()
  })
})

describe("config schema", () => {
  test("parses and normalizes the agent fallbackChain", () => {
    const agent = Schema.decodeUnknownSync(ConfigAgentV1.Info)({
      name: "build",
      model: "anthropic/claude-sonnet",
      fallbackChain: [
        { providers: ["anthropic", "openrouter"], model: "claude-sonnet", variant: "thinking" },
        { providers: ["openai"], model: "gpt-5" },
      ],
    })
    expect(agent.fallbackChain).toEqual([
      { providers: ["anthropic", "openrouter"], model: "claude-sonnet", variant: "thinking" },
      { providers: ["openai"], model: "gpt-5" },
    ])
    expect(agent.model).toBe("anthropic/claude-sonnet")
  })

  test("unknown config keys are not lost when fallbackChain is present", () => {
    const agent = Schema.decodeUnknownSync(ConfigAgentV1.Info)({
      name: "reviewer",
      fallbackChain: [{ providers: ["anthropic"], model: "claude-sonnet" }],
      custom_thing: { hello: "world" },
    })
    expect(agent.fallbackChain).toEqual([{ providers: ["anthropic"], model: "claude-sonnet" }])
    expect((agent.options as Record<string, unknown>).custom_thing).toEqual({ hello: "world" })
  })
})

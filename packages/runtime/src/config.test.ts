import { describe, expect, it } from "bun:test"
import { loadRuntimeSettings } from "./config"

describe("loadRuntimeSettings (harness floor)", () => {
  it("defaults: home ~/.newhorse, dataDir under it, openai provider, port 3927", () => {
    const s = loadRuntimeSettings({ env: {} })
    expect(s.agentHome.endsWith(".newhorse")).toBe(true)
    expect(s.dataDir.endsWith("data")).toBe(true)
    expect(s.provider.kind).toBe("openai")
    expect(s.port).toBe(3927)
    expect(s.memory.on).toBe(false)
  })

  it("env overrides defaults; AGENT_RUNTIME_HOME redirects the home", () => {
    const s = loadRuntimeSettings({ env: { AGENT_RUNTIME_HOME: "/custom/home", NEWHORSE_PROVIDER: "anthropic", NEWHORSE_MODEL: "m1", NEWHORSE_MEMORY: "on", NEWHORSE_MEMORY_VECTOR: "on" } })
    expect(s.agentHome).toBe("/custom/home")
    expect(s.provider.kind).toBe("anthropic")
    expect(s.provider.baseUrl).toBe("https://api.anthropic.com")
    expect(s.model).toBe("m1")
    expect(s.memory.on).toBe(true)
    expect(s.memory.vector.enabled).toBe(true)
    expect(s.memory.vector.embedding.model).toBe("embo-01")
  })

  it("cli overrides beat env (call-site intent wins)", () => {
    const s = loadRuntimeSettings({ env: { NEWHORSE_MODEL: "env-model" }, cli: { model: "cli-model", port: 5000 } })
    expect(s.model).toBe("cli-model")
    expect(s.port).toBe(5000)
  })

  it("contextWindowTokens: NEWHORSE_CONTEXT_WINDOW parses; invalid/absent stays undefined", () => {
    expect(loadRuntimeSettings({ env: { NEWHORSE_CONTEXT_WINDOW: "128000" } }).contextWindowTokens).toBe(128000)
    expect(loadRuntimeSettings({ env: {} }).contextWindowTokens).toBeUndefined()
    expect(loadRuntimeSettings({ env: { NEWHORSE_CONTEXT_WINDOW: "bogus" } }).contextWindowTokens).toBeUndefined()
    expect(loadRuntimeSettings({ env: { NEWHORSE_CONTEXT_WINDOW: "-5" } }).contextWindowTokens).toBeUndefined()
    expect(loadRuntimeSettings({ env: { NEWHORSE_CONTEXT_WINDOW: "999" }, cli: { contextWindowTokens: 4096 } }).contextWindowTokens).toBe(4096)
  })

  it("provider apiKey falls back to the kind-specific standard env", () => {
    const s = loadRuntimeSettings({ env: { NEWHORSE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-a" } })
    expect(s.provider.apiKey).toBe("sk-a")
  })
})

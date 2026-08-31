import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRuntimeSettings, writeAgentHomeConfig, readAgentHomeConfig } from "./config"

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

  it("maxOutputTokens: NEWHORSE_MAX_OUTPUT_TOKENS parses; invalid/absent stays undefined", () => {
    expect(loadRuntimeSettings({ env: { NEWHORSE_MAX_OUTPUT_TOKENS: "16384" } }).maxOutputTokens).toBe(16384)
    expect(loadRuntimeSettings({ env: {} }).maxOutputTokens).toBeUndefined()
    expect(loadRuntimeSettings({ env: { NEWHORSE_MAX_OUTPUT_TOKENS: "bogus" } }).maxOutputTokens).toBeUndefined()
  })

  it("provider apiKey falls back to the kind-specific standard env", () => {
    const s = loadRuntimeSettings({ env: { NEWHORSE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-a" } })
    expect(s.provider.apiKey).toBe("sk-a")
  })
})

  it("agent-home config file is a settings layer: defaults < file < env; write merges (unknown keys preserved)", async () => {
    const home = await mkdtemp(join(tmpdir(), "nh-cfg-"))
    try {
      // Empty home: defaults.
      expect(loadRuntimeSettings({ agentHome: home, env: {} }).model).toBe("gpt-4o-mini")
      // Write a patch: model + provider + an UNKNOWN key (must survive).
      await writeAgentHomeConfig(home, { model: "MiniMax-M2", provider: { kind: "anthropic", baseUrl: "https://api.minimaxi.com/anthropic", apiKey: "sk-file" } } as never)
      const raw = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(home, "config.json"), "utf8")) ) as Record<string, unknown>
      ;(raw as Record<string, unknown>).customFutureKey = 1
      await (await import("node:fs/promises")).writeFile(join(home, "config.json"), JSON.stringify(raw))
      // File layer effective when env silent.
      const s = loadRuntimeSettings({ agentHome: home, env: {} })
      expect(s.model).toBe("MiniMax-M2")
      expect(s.provider.kind).toBe("anthropic")
      expect(s.provider.apiKey).toBe("sk-file")
      // Env wins over file (ops override).
      const s2 = loadRuntimeSettings({ agentHome: home, env: { NEWHORSE_MODEL: "env-model" } })
      expect(s2.model).toBe("env-model")
      // readAgentHomeConfig returns the merged file with unknown keys intact.
      const cfg = await readAgentHomeConfig(home)
      expect((cfg as Record<string, unknown>).customFutureKey).toBe(1)
      // Corrupt file = empty layer, never a crash.
      await (await import("node:fs/promises")).writeFile(join(home, "config.json"), "{oops")
      expect(loadRuntimeSettings({ agentHome: home, env: {} }).model).toBe("gpt-4o-mini")
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("provider patch merges per field: a redacted client round-trip never wipes the stored key", async () => {
    const home = await mkdtemp(join(tmpdir(), "nh-cfg-"))
    try {
      await writeAgentHomeConfig(home, { provider: { kind: "openai-compatible", baseUrl: "https://x", apiKey: "sk-real-secret" } } as never)
      // The client PUTs the redacted view (hasApiKey/apiKeyHint, NO apiKey).
      await writeAgentHomeConfig(home, { provider: { kind: "openai-compatible", baseUrl: "https://y", hasApiKey: true, apiKeyHint: "…cret" } } as never)
      const cfg = await readAgentHomeConfig(home)
      const provider = cfg.provider as { kind: string; baseUrl: string; apiKey?: string; hasApiKey?: boolean; apiKeyHint?: boolean }
      expect(provider.apiKey).toBe("sk-real-secret") // survived
      expect(provider.baseUrl).toBe("https://y") // updated
      expect(provider.hasApiKey).toBeUndefined() // display junk stripped
      expect(provider.apiKeyHint).toBeUndefined()
      const s = loadRuntimeSettings({ agentHome: home, env: {} })
      expect(s.provider.apiKey).toBe("sk-real-secret")
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

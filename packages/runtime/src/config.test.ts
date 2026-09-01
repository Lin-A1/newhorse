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

  it("provider presets (ccswitch): upsert merges per field by id; a redacted round-trip keeps the stored key", async () => {
    const home = await mkdtemp(join(tmpdir(), "nh-cfg-"))
    try {
      await writeAgentHomeConfig(home, { providers: [{ id: "p1", name: "DeepSeek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "sk-ds", model: "deepseek-chat", contextWindowTokens: 64000 }] } as never)
      // Client round-trip without apiKey (redacted view) must keep the key.
      await writeAgentHomeConfig(home, { providers: [{ id: "p1", name: "DeepSeek renamed", baseUrl: "https://api.deepseek.com/v1", hasApiKey: true, apiKeyHint: "…sk-ds" }] } as never)
      const cfg = await readAgentHomeConfig(home)
      const p = (cfg.providers ?? [])[0] as Record<string, unknown>
      expect(p.apiKey).toBe("sk-ds")
      expect(p.name).toBe("DeepSeek renamed")
      expect(p.hasApiKey).toBeUndefined()
      expect(p.apiKeyHint).toBeUndefined()
      // Effective settings normalize the preset (name fallback etc. never leaks).
      const s = loadRuntimeSettings({ agentHome: home, env: {} })
      expect(s.providers?.[0]?.model).toBe("deepseek-chat")
      expect(s.providers?.[0]?.contextWindowTokens).toBe(64000)
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("provider presets (ccswitch): activeProviderId makes the preset the file-layer provider+model+budgets; env still overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "nh-cfg-"))
    try {
      await writeAgentHomeConfig(home, {
        model: "gpt-4o-mini",
        providers: [{ id: "a", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-a", model: "claude-sonnet-4", contextWindowTokens: 200000 }],
        activeProviderId: "a",
      } as never)
      const s = loadRuntimeSettings({ agentHome: home, env: {} })
      expect(s.activeProviderId).toBe("a")
      expect(s.provider.kind).toBe("anthropic")
      expect(s.provider.baseUrl).toBe("https://api.anthropic.com")
      expect(s.provider.apiKey).toBe("sk-a")
      expect(s.model).toBe("claude-sonnet-4")
      expect(s.contextWindowTokens).toBe(200000)
      // env stays the ops override above the file (preset included).
      const s2 = loadRuntimeSettings({ agentHome: home, env: { NEWHORSE_MODEL: "env-model" } })
      expect(s2.model).toBe("env-model")
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("provider presets (ccswitch): providersRemove drops ids and clears a dangling activeProviderId", async () => {
    const home = await mkdtemp(join(tmpdir(), "nh-cfg-"))
    try {
      await writeAgentHomeConfig(home, {
        providers: [
          { id: "a", name: "A", kind: "openai", baseUrl: "https://a" },
          { id: "b", name: "B", kind: "openai", baseUrl: "https://b", model: "m-b" },
        ],
        activeProviderId: "b",
      } as never)
      await writeAgentHomeConfig(home, { providersRemove: ["b"] } as never)
      const cfg = await readAgentHomeConfig(home)
      expect((cfg.providers ?? []).map((p) => p.id)).toEqual(["a"])
      const s = loadRuntimeSettings({ agentHome: home, env: {} })
      expect(s.activeProviderId).toBeUndefined()
      // Falls back to the standalone provider + file model.
      expect(s.model).toBe("gpt-4o-mini")
      expect(s.provider.baseUrl).toBe("https://api.openai.com")
      // Removing the LAST preset must drop the key entirely (a removal always
      // wins over the stored list, even when the merged list is empty).
      await writeAgentHomeConfig(home, { providersRemove: ["a"] } as never)
      const cfg2 = await readAgentHomeConfig(home)
      expect(cfg2.providers).toBeUndefined()
      expect(loadRuntimeSettings({ agentHome: home, env: {} }).providers).toBeUndefined()
      expect("providersRemove" in cfg2).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

describe("provider preset field clearing (empty-string semantics)", () => {
  it("'' on baseUrl/model/budgets CLEARS the stored value; '' on apiKey KEEPS the key", async () => {
    const home = await mkdtemp(join(tmpdir(), "nh-clear-"))
    try {
      await writeAgentHomeConfig(home, { providers: [{ id: "p", name: "P", kind: "openai-compatible", baseUrl: "https://x", apiKey: "sk-keep", model: "old-model", contextWindowTokens: 32000 }] } as never)
      // The editor sends the full form: budgets cleared to "", key untouched.
      await writeAgentHomeConfig(home, { providers: [{ id: "p", model: "", contextWindowTokens: "", maxOutputTokens: "", apiKey: "" }] } as never)
      const cfg = await readAgentHomeConfig(home)
      const p = (cfg.providers ?? [])[0] as Record<string, unknown>
      expect(p.model).toBeUndefined() // cleared
      expect(p.contextWindowTokens).toBeUndefined()
      expect(p.maxOutputTokens).toBeUndefined()
      expect(p.baseUrl).toBe("https://x") // untouched (not sent)
      expect(p.apiKey).toBe("sk-keep") // "" kept the key
      const s = loadRuntimeSettings({ agentHome: home, env: {} })
      expect(s.providers?.[0]?.model).toBeUndefined()
      expect(s.providers?.[0]?.apiKey).toBe("sk-keep")
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("embedding config (file layer)", () => {
  it("memory.vector.embedding persists in the agent-home config; env overrides; the key never reaches the redacted view", async () => {
    const home = await mkdtemp(join(tmpdir(), "nh-emb-"))
    try {
      await writeAgentHomeConfig(home, { memory: { on: true, vector: { enabled: true, embedding: { kind: "openai-compatible", baseUrl: "https://emb.example/v1", apiKey: "sk-emb", model: "text-embed-3" } } } } as never)
      const s = loadRuntimeSettings({ agentHome: home, env: {} })
      expect(s.memory.vector.enabled).toBe(true)
      expect(s.memory.vector.embedding.baseUrl).toBe("https://emb.example/v1")
      expect(s.memory.vector.embedding.apiKey).toBe("sk-emb")
      expect(s.memory.vector.embedding.model).toBe("text-embed-3")
      // env stays the ops override
      const s2 = loadRuntimeSettings({ agentHome: home, env: { NEWHORSE_EMBEDDING_MODEL: "override-emb" } })
      expect(s2.memory.vector.embedding.model).toBe("override-emb")
      // redaction: the key never reaches the client view
      const { redactSettings } = await import("./settings-api")
      const view = redactSettings(s)
      expect(view.memory.vector.embedding.apiKey).toBe("")
      expect(view.memory.vector.embedding.hasApiKey).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("embedding round-trip (redacted client)", () => {
  it("an empty-string embedding apiKey KEEPS the stored key; junk display fields never persist", async () => {
    const home = await mkdtemp(join(tmpdir(), "nh-emb2-"))
    try {
      await writeAgentHomeConfig(home, { memory: { on: true, vector: { enabled: true, embedding: { kind: "openai-compatible", baseUrl: "https://emb.example/v1", apiKey: "sk-keep", model: "m-1" } } } } as never)
      // the client PUTs the redacted view back (apiKey "" + hasApiKey junk)
      await writeAgentHomeConfig(home, { memory: { on: true, vector: { enabled: true, mode: "auto", embedding: { kind: "openai-compatible", baseUrl: "https://emb.example/v1", apiKey: "", model: "m-1", hasApiKey: true, apiKeyHint: "…keep" } } } } as never)
      const cfg = await readAgentHomeConfig(home)
      const emb = (cfg.memory?.vector as { embedding?: Record<string, unknown> } | undefined)?.embedding ?? {}
      expect(emb.apiKey).toBe("sk-keep")
      expect(emb.hasApiKey).toBeUndefined()
      expect(emb.apiKeyHint).toBeUndefined()
      expect(cfg.memory?.vector?.embedding?.model).toBe("m-1")
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })
})

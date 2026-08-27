import { describe, expect, it } from "bun:test"
import { PluginRegistry } from "./registry"
import type { Capability } from "./registry"
import { Container, defineService } from "@newhorse/core"

describe("plugin registry", () => {
  it("registers and lists each capability kind", () => {
    const r = new PluginRegistry()
    r.register({ kind: "tool", name: "search", execute: async () => 1 })
    r.register({ kind: "agent", name: "explore", description: "d" })
    r.register({ kind: "command", name: "plan", description: "p", run: async () => "x" })
    r.register({ kind: "hook", name: "h1", event: "pre-tool-use", mode: "command", run: async () => null })

    expect(r.list("tool").length).toBe(1)
    expect(r.list("agent")[0]!.name).toBe("explore")
    expect(r.list("command")[0]!.name).toBe("plan")
    expect(r.list("hook")[0]!.event).toBe("pre-tool-use")
  })

  it("rejects duplicate registration of the same key", () => {
    const r = new PluginRegistry()
    r.register({ kind: "tool", name: "search", execute: async () => 1 })
    expect(() => r.register({ kind: "tool", name: "search", execute: async () => 2 })).toThrow()
  })

  it("disposer un-registers and allows re-registration", () => {
    const r = new PluginRegistry()
    const d = r.register({ kind: "agent", name: "a" })
    expect(r.list("agent").length).toBe(1)
    d()
    expect(r.list("agent").length).toBe(0)
  })

  it("gets a single capability by kind + name", () => {
    const r = new PluginRegistry()
    r.register({ kind: "tool", name: "search", execute: async () => 1 })
    expect(r.get("tool", "search")).toBeDefined()
    expect(r.get("tool", "missing")).toBeUndefined()
  })

  it("collects all capabilities across kinds", () => {
    const r = new PluginRegistry()
    const caps: Capability[] = [
      { kind: "tool", name: "t", execute: async () => 1 },
      { kind: "agent", name: "a" },
    ]
    for (const c of caps) r.register(c)
    expect(r.all().length).toBe(2)
  })

  it("registerAll tears down every registration on dispose", () => {
    const r = new PluginRegistry()
    const d = r.registerAll([
      { kind: "tool", name: "t", execute: async () => 1 },
      { kind: "agent", name: "a" },
    ])
    expect(r.all().length).toBe(2)
    d()
    expect(r.all().length).toBe(0)
  })

  it("provider capability composes its Container disposer", () => {
    const container = new Container()
    const reg = defineService<number>("x")
    const r = new PluginRegistry(container)
    let disposed = false
    r.register({
      kind: "provider",
      id: "p",
      register: (c) => c.register(reg, 42, () => { disposed = true }),
    })
    expect(container.get(reg)).toBe(42)
    // dispose the registry -> teardown the provider's Container registration too
    r.dispose()
    expect(disposed).toBe(true)
    expect(() => container.get(reg)).toThrow()
  })
})

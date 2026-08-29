import { describe, expect, it } from "bun:test"
import { resolveAgent, resolveAgentTools, resolveAgentModel, type AgentDefinition } from "./agent-resolver"
import type { Tool } from "@newhorse/core"

const parentTools: Tool[] = [
  { name: "read", execute: async () => "r" },
  { name: "write", execute: async () => "w" },
  { name: "bash", execute: async () => "b" },
]

describe("agent resolver (role overlay, Phase 4)", () => {
  it("allowedTools narrows the parent set (restrictive, never widens)", () => {
    // A whitelist naming tools the parent DOES have → narrowed to those.
    const def: AgentDefinition = { name: "researcher", allowedTools: ["read", "write"] }
    const resolved = resolveAgent(def, { tools: parentTools, model: "parent-model" })
    expect(resolved.tools.map((t) => t.name).sort()).toEqual(["read", "write"])
    // A tool the agent names but the parent lacks is NOT added (no widening).
    const def2: AgentDefinition = { name: "hacker", allowedTools: ["read", "ssh"] }
    const resolved2 = resolveAgent(def2, { tools: parentTools, model: "m" })
    expect(resolved2.tools.map((t) => t.name)).toEqual(["read"])
  })

  it("no allowedTools inherits ALL parent tools", () => {
    const resolved = resolveAgent(undefined, { tools: parentTools, model: "m" })
    expect(resolved.tools.length).toBe(3)
  })

  it("model precedence: explicit > agent.model > costDown > inherited", () => {
    const def: AgentDefinition = { name: "r", model: "agent-model" }
    expect(resolveAgent(def, { tools: [], model: "parent" }, "explicit").model).toBe("explicit")
    expect(resolveAgent(def, { tools: [], model: "parent" }).model).toBe("agent-model")
    expect(resolveAgent(undefined, { tools: [], model: "parent" }).model).toBe("parent")
  })

  it("resolveAgentTools returns a filtered copy", () => {
    expect(resolveAgentTools(parentTools, ["read"]).map((t) => t.name)).toEqual(["read"])
  })

  it("resolveAgentModel falls back correctly", () => {
    expect(resolveAgentModel({ name: "r", model: "m" }, "x", "p", "c")).toBe("x")
    expect(resolveAgentModel({ name: "r", model: "m" }, undefined, "p", "c")).toBe("m")
    expect(resolveAgentModel(undefined, undefined, undefined, "c")).toBe("c")
    expect(resolveAgentModel(undefined, undefined, "p")).toBe("p")
  })
})

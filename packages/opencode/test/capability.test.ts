import { expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Capability } from "@/capability"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Agent.node, Capability.node])))

it.instance("reports platform-enforced capabilities after session rules", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const capability = yield* Capability.Service
    const researcher = yield* agents.get("researcher")
    const snapshot = yield* capability.inspect({
      agent: researcher,
      permission: [
        { permission: "edit", pattern: "/secret/project/*", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "task", pattern: "*", action: "allow" },
      ],
    })

    expect(Object.fromEntries(snapshot.capabilities.map((entry) => [entry.name, entry.action]))).toMatchObject({
      read: "allow",
      edit: "deny",
      shell: "deny",
      delegate: "deny",
    })
    expect(JSON.stringify(snapshot)).not.toContain("/secret/project")
    expect(JSON.stringify(snapshot)).not.toContain("pattern")
  }),
)

it.instance("returns a redacted workspace capability snapshot with coding tools", () =>
  Effect.gen(function* () {
    const capability = yield* Capability.Service
    const snapshot = yield* capability.current({
      toolIDs: ["read", "write", "edit", "bash", "memory", "reminder", "skill"],
    })
    const tools = Object.fromEntries(snapshot.tools.map((entry) => [entry.id, entry.action]))
    const json = JSON.stringify(snapshot)

    expect(snapshot.workspace.kind).toBe("project")
    expect(snapshot.workspace.contentScope).toBe("project")
    expect(snapshot.agent.current).toBe("build")
    expect(snapshot.agent.items.some((item) => item.name === snapshot.agent.default)).toBe(true)
    expect(snapshot.agent.items.every((item) => !("description" in item))).toBe(true)
    expect(snapshot.skills.every((item) => !("description" in item))).toBe(true)
    expect(tools.read).toBeDefined()
    expect(tools.write).toBeDefined()
    expect(tools.edit).toBeDefined()
    expect(tools.bash).toBeDefined()
    expect(json).not.toContain('"prompt"')
    expect(json).not.toContain('"options"')
    expect(json).not.toContain('"location"')
    expect(json).not.toContain('"content"')
    expect(json).not.toContain('"directory"')
    expect(json).not.toContain('"error"')
  }),
)

it.instance("uses runtime permission aliases and caller overrides for tools", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const capability = yield* Capability.Service
    const build = yield* agents.get("build")
    const snapshot = yield* capability.current({
      toolIDs: ["edit", "write", "apply_patch", "list_mcp_resources"],
      agent: build,
      permission: [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "read", pattern: "*", action: "ask" },
        { permission: "skill", pattern: "*", action: "deny" },
        { permission: "memory", pattern: "*", action: "deny" },
        { permission: "reminder", pattern: "*", action: "deny" },
      ],
    })
    const tools = Object.fromEntries(snapshot.tools.map((entry) => [entry.id, entry.action]))

    expect(snapshot.agent.current).toBe("build")
    expect(tools.edit).toBe("deny")
    expect(tools.write).toBe("deny")
    expect(tools.apply_patch).toBe("deny")
    expect(tools.list_mcp_resources).toBe("ask")
    expect(snapshot.skills).toEqual([])
    expect(snapshot.memory.availability).toEqual({ available: false, reason: "permission_denied" })
    expect(snapshot.reminders.availability).toEqual({ available: false, reason: "permission_denied" })
  }),
)

it.instance("keeps full coding capability visible for the build agent", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const capability = yield* Capability.Service
    const build = yield* agents.get("build")
    const snapshot = yield* capability.inspect({ agent: build })
    const status = Object.fromEntries(snapshot.capabilities.map((entry) => [entry.name, entry.action]))

    expect(status.read).toBe("conditional")
    expect(status.edit).toBe("allow")
    expect(status.shell).toBe("allow")
    expect(status.delegate).toBe("allow")
    expect(status.memory).toBe("ask")
  }),
)

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

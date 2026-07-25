import { LayerNode } from "@newhorse/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Agent.node))

const EDIT_TOOLS = ["edit", "write", "apply_patch"]

it.instance("prototype assistant agent is not registered", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.use.list()
    expect(agents.find((agent) => agent.name === "assistant")).toBeUndefined()
    expect(agents.find((agent) => agent.name === "build")).toBeDefined()
  }),
)

it.instance("researcher cannot write, run shell, or delegate", () =>
  Effect.gen(function* () {
    const researcher = yield* Agent.use.get("researcher")

    expect(Permission.evaluate("read", "README.md", researcher.permission).action).toBe("allow")
    expect(Permission.evaluate("webfetch", "https://example.com", researcher.permission).action).toBe("allow")
    expect(Permission.evaluate("edit", "/x.ts", researcher.permission).action).toBe("deny")
    expect(Permission.evaluate("bash", "git status", researcher.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "general", researcher.permission).action).toBe("deny")
    expect(Permission.disabled(EDIT_TOOLS, researcher.permission)).toEqual(new Set(EDIT_TOOLS))
  }),
)

it.instance("writer asks before writing and cannot run shell or delegate", () =>
  Effect.gen(function* () {
    const writer = yield* Agent.use.get("writer")

    expect(Permission.evaluate("read", "notes.md", writer.permission).action).toBe("allow")
    expect(Permission.evaluate("edit", "notes.md", writer.permission).action).toBe("ask")
    expect(Permission.evaluate("write", "notes.md", writer.permission).action).toBe("ask")
    expect(Permission.evaluate("bash", "ls", writer.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "general", writer.permission).action).toBe("deny")
  }),
)

it.instance("self is read-only and cannot delegate", () =>
  Effect.gen(function* () {
    const self = yield* Agent.use.get("self")

    expect(Permission.evaluate("read", "opencode.json", self.permission).action).toBe("allow")
    expect(Permission.evaluate("edit", "opencode.json", self.permission).action).toBe("deny")
    expect(Permission.evaluate("bash", "env", self.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "general", self.permission).action).toBe("deny")
  }),
)

it.instance(
  "user config cannot loosen the enforced denies on new agents",
  () =>
    Effect.gen(function* () {
      const researcher = yield* Agent.use.get("researcher")
      const writer = yield* Agent.use.get("writer")
      const self = yield* Agent.use.get("self")

      expect(Permission.evaluate("edit", "/x.ts", researcher.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "rm -rf /", researcher.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "general", researcher.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "rm -rf /", writer.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "general", writer.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "/x.ts", self.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "general", self.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        edit: "allow",
        bash: "allow",
        task: "allow",
      },
    },
  },
)

// Long-term memory outlives the session, so it must never be swept in by `* allow`.
it.instance("memory writes require confirmation by default", () =>
  Effect.gen(function* () {
    const build = yield* Agent.use.get("build")
    expect(Permission.evaluate("memory", "*", build.permission).action).toBe("ask")
  }),
)

it.instance("build keeps full code capability", () =>
  Effect.gen(function* () {
    const build = yield* Agent.use.get("build")

    expect(Permission.evaluate("edit", "/x.ts", build.permission).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", build.permission).action).toBe("allow")
    expect(Permission.evaluate("task", "general", build.permission).action).toBe("allow")
    expect(Permission.disabled(EDIT_TOOLS, build.permission)).toEqual(new Set())
  }),
)

it.instance("read-only agents stay locked down when spawned as subagents", () =>
  Effect.gen(function* () {
    const self = yield* Agent.use.get("self")
    const effective = Permission.merge(
      self.permission,
      deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: self }),
    )

    expect(Permission.evaluate("edit", "/x.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "env", effective).action).toBe("deny")
    expect(Permission.evaluate("task", "general", effective).action).toBe("deny")
  }),
)

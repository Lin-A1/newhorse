import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { personalDirectory } from "../../src/control-plane/adapters/personal"
import { Permission } from "../../src/permission"
import { ToolRegistry } from "../../src/tool/registry"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node])))

// Code capability is the foundation every other personal-space capability is
// built on (notes, analysis, output generation), so a personal workspace must
// expose the same toolset a project does.
const CODE_TOOLS = ["read", "write", "edit", "grep", "glob", "bash", "task", "todowrite", "skill"]

function personalInstance<A, E, R>(name: string, self: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const directory = personalDirectory(name)
    yield* Effect.promise(() => fs.mkdir(path.join(directory, "notes"), { recursive: true }))
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })))
    return yield* self(directory).pipe(provideInstance(directory))
  }).pipe(Effect.provide(testInstanceStoreLayer))
}

it.live("personal workspace exposes the full code toolset", () =>
  personalInstance("code-capability", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      for (const tool of CODE_TOOLS) {
        expect(ids).toContain(tool)
      }
    }),
  ),
)

it.live("build agent keeps write and shell permission in a personal workspace", () =>
  personalInstance("code-permission", () =>
    Effect.gen(function* () {
      const build = yield* Agent.use.get("build")

      expect(Permission.evaluate("edit", "notes/todo.md", build.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "ls", build.permission).action).toBe("allow")
      expect(Permission.disabled(["edit", "write", "apply_patch"], build.permission)).toEqual(new Set())
    }),
  ),
)

it.live("personal workspace can write and read a note through normal file tools", () =>
  personalInstance("note-roundtrip", (directory) =>
    Effect.gen(function* () {
      const notePath = path.join(directory, "notes", "groceries.md")
      yield* Effect.promise(() => fs.writeFile(notePath, "- oat milk\n"))
      const content = yield* Effect.promise(() => fs.readFile(notePath, "utf8"))
      expect(content).toContain("oat milk")
    }),
  ),
)

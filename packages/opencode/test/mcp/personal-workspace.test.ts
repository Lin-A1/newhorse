import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Effect } from "effect"
import { personalDirectory } from "../../src/control-plane/adapters/personal"
import { MCP } from "../../src/mcp/index"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))

const UNREACHABLE = "http://127.0.0.1:9/mcp"

function personalInstance<A, E, R>(name: string, self: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const directory = personalDirectory(name)
    yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(directory, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "project-only": { type: "remote", url: UNREACHABLE, enabled: true },
            "personal-ok": { type: "remote", url: UNREACHABLE, enabled: true, personal: true },
          },
        }),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })))
    return yield* self(directory).pipe(provideInstance(directory))
  }).pipe(Effect.provide(testInstanceStoreLayer))
}

it.live("personal workspace disables MCP servers that did not opt in", () =>
  personalInstance("mcp-filter", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const status = yield* mcp.status()
      const blocked = status["project-only"]
      expect(blocked?.status).toBe("disabled")
      // the reason must distinguish this from an explicit `enabled: false`
      expect(blocked).toMatchObject({ status: "disabled", reason: "personal_workspace" })
      // opted in, so it is allowed to attempt a connection (and fail on a dead port)
      expect(status["personal-ok"]?.status).not.toBe("disabled")
    }),
  ),
)

it.live("connect() cannot re-enable a non-personal server inside a personal workspace", () =>
  personalInstance("mcp-connect", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.connect("project-only")
      const status = yield* mcp.status()
      expect(status["project-only"]?.status).toBe("disabled")
    }),
  ),
)

it.instance(
  "project workspace keeps MCP servers enabled without opt-in",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const status = yield* mcp.status()
      expect(status["project-only"]?.status).not.toBe("disabled")
    }),
  {
    config: {
      mcp: { "project-only": { type: "remote", url: UNREACHABLE, enabled: true } },
    } as any,
  },
)

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { Npm } from "@newhorse/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@newhorse/core/provider"
import { ModelV2 } from "@newhorse/core/model"
import { AppNodeBuilder } from "@newhorse/core/effect/app-node-builder"
import { LayerNode } from "@newhorse/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.instance("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
      }),
    ),
  )

  it.instance("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )

  it.instance("skips hooks whose matcher does not match the input", () =>
    withProject(
      [
        "export default async () => ({",
        '  matchers: { "tool.execute.before": "edit" },',
        '  "tool.execute.before": (_input, output) => {',
        '    output.args.matched = true',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const hit: { args: { matched?: boolean } } = { args: {} }
        yield* plugin.trigger("tool.execute.before", { tool: "edit", sessionID: "session", callID: "call" }, hit)
        expect(hit.args.matched).toBe(true)
        const miss: { args: { matched?: boolean } } = { args: {} }
        yield* plugin.trigger("tool.execute.before", { tool: "bash", sessionID: "session", callID: "call" }, miss)
        expect(miss.args.matched).toBeUndefined()
      }),
    ),
  )

  it.instance("permission.ask matcher filters by permission name and pattern", () =>
    withProject(
      [
        "export default async () => ({",
        '  matchers: { "permission.ask": "read" },',
        '  "permission.ask": (_input, output) => {',
        '    output.status = "deny"',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const hit: { status: "ask" | "deny" | "allow" } = { status: "ask" }
        yield* plugin.trigger(
          "permission.ask",
          { permission: "read", patterns: ["*.env"], sessionID: "session", metadata: {}, always: [] },
          hit,
        )
        expect(hit.status).toBe("deny")
        const miss: { status: "ask" | "deny" | "allow" } = { status: "ask" }
        yield* plugin.trigger(
          "permission.ask",
          { permission: "bash", patterns: ["ls"], sessionID: "session", metadata: {}, always: [] },
          miss,
        )
        expect(miss.status).toBe("ask")
      }),
    ),
  )
})

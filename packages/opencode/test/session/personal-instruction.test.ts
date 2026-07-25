import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@newhorse/core/effect/app-node-builder"
import { LayerNodePlatform } from "@newhorse/core/effect/app-node-platform"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Global } from "@newhorse/core/global"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { personalDirectory } from "../../src/control-plane/adapters/personal"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Instruction } from "../../src/session/instruction"
import { TestConfig } from "../fixture/config"
import { provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const instructionLayer = (dir: string) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, Layer.succeed(Config.Service, TestConfig.make())],
    [Global.node, Global.layerWith({ home: dir, config: dir })],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
  ])

describe("personal workspace instructions", () => {
  // A personal space is a plain non-git directory, so AGENTS.md there must be
  // picked up by the existing findUp walk without any personal-specific plumbing.
  it.live("loads AGENTS.md placed in a personal workspace", () =>
    Effect.gen(function* () {
      const directory = personalDirectory("instruction-pickup")
      yield* Effect.promise(() => fs.mkdir(path.join(directory, "notes"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "AGENTS.md"), "# Personal space rules\n"))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })))

      const paths = yield* Instruction.Service.use((svc) => svc.systemPaths()).pipe(
        Effect.provide(instructionLayer(directory)),
        provideInstance(directory),
      )

      expect(paths.has(path.join(directory, "AGENTS.md"))).toBe(true)
    }),
  )
})

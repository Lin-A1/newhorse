import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@newhorse/core/effect/app-node"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@newhorse/core/installation/version"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function testLayer(
  spawnHandler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () => "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const standard = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = spawnHandler(standard?.command ?? "", standard?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [[CrossSpawnSpawner.node, spawnerNode]])
}

describe("installation", () => {
  testEffect(testLayer()).effect("reports the current fork version without release lookup", () =>
    Effect.gen(function* () {
      expect(yield* Installation.use.latest("unknown")).toBe(InstallationVersion)
      expect(yield* Installation.use.latest("npm")).toBe(InstallationVersion)
    }),
  )

  for (const method of ["curl", "npm", "pnpm", "bun", "brew", "scoop", "choco", "unknown"] as const) {
    testEffect(testLayer(() => { throw new Error("unexpected installer process") })).effect(
      `requires manual replacement for ${method} upgrades`,
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgrade(method, "9.9.9"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toBe("Newhorse upgrades require replacing the portable binary manually.")
        }),
    )
  }
})

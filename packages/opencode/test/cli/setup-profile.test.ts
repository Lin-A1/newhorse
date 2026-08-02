import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"

describe("nh setup", () => {
  cliIt.concurrent(
    "configures and activates a profile non-interactively",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "setup",
          "profile",
          "companion",
          "--name",
          "Anchor",
          "--persona",
          "Warm and direct",
          "--memory",
          "auto-safe",
          "--proactive",
          "--quiet-start",
          "22:00",
          "--quiet-end",
          "07:00",
          "--timezone",
          "Asia/Shanghai",
          "--max-per-day",
          "2",
          "--min-interval-minutes",
          "180",
          "--crisis-region",
          "CN",
          "--activate",
          "--json",
        ])
        opencode.expectExit(result, 0)
        expect(JSON.parse(result.stdout)).toMatchObject({
          id: "companion",
          name: "Anchor",
          persona: "Warm and direct",
          memory: "auto-safe",
          proactive: true,
          quietHours: { start: "22:00", end: "07:00", timezone: "Asia/Shanghai" },
          proactiveFrequency: { maxPerDay: 2, minIntervalMinutes: 180 },
          crisisRegion: "CN",
        })

        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "newhorse", "newhorse.jsonc")).json(),
        )
        expect(config.profile.active).toBe("companion")
        expect(config.profile.items.companion).toMatchObject({
          kind: "companion",
          name: "Anchor",
          persona: "Warm and direct",
          proactive: true,
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "preserves the existing frequency field during a partial update",
    ({ opencode }) =>
      Effect.gen(function* () {
        const configured = yield* opencode.spawn([
          "setup",
          "profile",
          "companion",
          "--max-per-day",
          "7",
          "--min-interval-minutes",
          "240",
        ])
        opencode.expectExit(configured, 0)

        const updated = yield* opencode.spawn(["setup", "profile", "companion", "--max-per-day", "5", "--json"])
        opencode.expectExit(updated, 0)
        expect(JSON.parse(updated.stdout).proactiveFrequency).toEqual({
          maxPerDay: 5,
          minIntervalMinutes: 240,
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects incomplete quiet hours without writing profile config",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "setup",
          "profile",
          "companion",
          "--quiet-start",
          "22:00",
          "--quiet-end",
          "07:00",
        ])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("--quiet-start, --quiet-end, and --timezone must be provided together")
        expect(
          yield* Effect.promise(() => Bun.file(path.join(home, ".config", "newhorse", "newhorse.jsonc")).exists()),
        ).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects malformed quiet hour values before writing profile config",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "setup",
          "profile",
          "companion",
          "--quiet-start",
          "25:00",
          "--quiet-end",
          "07:00",
          "--timezone",
          "UTC",
        ])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Invalid quiet hours start: 25:00")
        expect(
          yield* Effect.promise(() => Bun.file(path.join(home, ".config", "newhorse", "newhorse.jsonc")).exists()),
        ).toBe(false)
      }),
    60_000,
  )
  cliIt.concurrent(
    "reuses the MCP add workflow",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["setup", "mcp", "github", "--url", "https://example.com/mcp"])
        opencode.expectExit(result, 0)
        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "newhorse", "newhorse.json")).json(),
        )
        expect(config.mcp.github).toEqual({ type: "remote", url: "https://example.com/mcp" })
      }),
    60_000,
  )
})

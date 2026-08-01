import * as prompts from "@clack/prompts"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { AgentCreateCommand } from "./agent"
import { McpAddCommand } from "./mcp"
import { Profile } from "@/profile"
import type { ConfigProfileV1 } from "@newhorse/core/v1/config/profile"

interface ProfileArgs {
  id?: string
  name?: string
  persona?: string
  memory?: ConfigProfileV1.MemoryPolicy
  proactive?: boolean
  paused?: boolean
  quietStart?: string
  quietEnd?: string
  timezone?: string
  maxPerDay?: number
  minIntervalMinutes?: number
  crisisRegion?: string
  activate?: boolean
  json?: boolean
}

const profileBuilder = (yargs: Argv) =>
  yargs
    .positional("id", { type: "string", choices: ["assistant", "companion"] as const })
    .option("name", { type: "string", describe: "profile display name" })
    .option("persona", { type: "string", describe: "profile persona instructions" })
    .option("memory", {
      type: "string",
      choices: ["off", "ask", "auto-safe"] as const,
      describe: "long-term memory policy",
    })
    .option("proactive", { type: "boolean", describe: "enable proactive messages" })
    .option("paused", { type: "boolean", describe: "pause proactive messages" })
    .option("quiet-start", { type: "string", describe: "quiet hours start in HH:mm" })
    .option("quiet-end", { type: "string", describe: "quiet hours end in HH:mm" })
    .option("timezone", { type: "string", describe: "quiet hours IANA timezone" })
    .option("max-per-day", { type: "number", describe: "maximum proactive messages per day" })
    .option("min-interval-minutes", { type: "number", describe: "minimum minutes between proactive messages" })
    .option("crisis-region", { type: "string", describe: "crisis support region" })
    .option("activate", { type: "boolean", describe: "use this profile for new sessions" })
    .option("json", { type: "boolean", describe: "print the configured runtime as JSON", default: false })

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function hasConfiguration(args: ProfileArgs) {
  return [
    args.name,
    args.persona,
    args.memory,
    args.proactive,
    args.paused,
    args.quietStart,
    args.quietEnd,
    args.timezone,
    args.maxPerDay,
    args.minIntervalMinutes,
    args.crisisRegion,
    args.activate,
  ].some((value) => value !== undefined)
}

function validateFlags(args: ProfileArgs) {
  const quiet = [args.quietStart, args.quietEnd, args.timezone]
  if (quiet.some((value) => value !== undefined) && quiet.some((value) => value === undefined)) {
    return "--quiet-start, --quiet-end, and --timezone must be provided together"
  }
  if (args.timezone && !validTimezone(args.timezone)) return `Invalid IANA timezone: ${args.timezone}`
  if (
    args.maxPerDay !== undefined &&
    (!Number.isInteger(args.maxPerDay) || args.maxPerDay < 1 || args.maxPerDay > 24)
  ) {
    return "--max-per-day must be an integer between 1 and 24"
  }
  if (
    args.minIntervalMinutes !== undefined &&
    (!Number.isInteger(args.minIntervalMinutes) || args.minIntervalMinutes < 1 || args.minIntervalMinutes > 1440)
  ) {
    return "--min-interval-minutes must be an integer between 1 and 1440"
  }
}

const ProfileSetupCommand = effectCmd({
  command: "profile [id]",
  describe: "configure Assistant or Companion",
  builder: profileBuilder,
  handler: Effect.fn("Cli.setup.profile")(function* (args: ProfileArgs) {
    const profiles = yield* Profile.Service
    const scripted = hasConfiguration(args)
    if (scripted && !args.id) return yield* fail("A profile ID is required when using configuration flags")
    const invalid = validateFlags(args)
    if (invalid) return yield* fail(invalid)

    let id = args.id as "assistant" | "companion" | undefined
    let proactiveFrequency: Profile.Update["proactiveFrequency"]
    if (scripted && (args.maxPerDay !== undefined || args.minIntervalMinutes !== undefined)) {
      const current = yield* profiles
        .runtime(Profile.ID.make(id!))
        .pipe(Effect.catchTag("ProfileNotFoundError", (error) => fail(error.message)))
      proactiveFrequency = {
        maxPerDay: args.maxPerDay ?? current.proactiveFrequency.maxPerDay,
        minIntervalMinutes: args.minIntervalMinutes ?? current.proactiveFrequency.minIntervalMinutes,
      }
    }
    let update: Profile.Update = {
      name: args.name,
      persona: args.persona,
      memory: args.memory,
      proactive: args.proactive,
      proactivePaused: args.paused,
      quietHours:
        args.quietStart && args.quietEnd && args.timezone
          ? { start: args.quietStart, end: args.quietEnd, timezone: args.timezone }
          : undefined,
      proactiveFrequency,
      crisisRegion: args.crisisRegion,
    }
    let activate = args.activate ?? false

    if (!scripted) {
      const all = yield* profiles.list()
      const active = yield* profiles.activeID()
      UI.empty()
      prompts.intro("Set up profile")
      if (!id) {
        const selected = yield* Effect.promise(() =>
          prompts.select({
            message: "Profile",
            options: all.map((item) => ({ label: item.name, value: item.id, hint: item.kind })),
            initialValue: active,
          }),
        )
        if (prompts.isCancel(selected)) throw new UI.CancelledError()
        id = selected as "assistant" | "companion"
      }
      const current = yield* profiles
        .runtime(Profile.ID.make(id))
        .pipe(Effect.catchTag("ProfileNotFoundError", (error) => fail(error.message)))
      const name = yield* Effect.promise(() =>
        prompts.text({
          message: "Display name",
          initialValue: current.name,
          validate: (value) => (value ? undefined : "Required"),
        }),
      )
      if (prompts.isCancel(name)) throw new UI.CancelledError()
      const persona = yield* Effect.promise(() =>
        prompts.text({ message: "Persona instructions", initialValue: current.persona ?? "" }),
      )
      if (prompts.isCancel(persona)) throw new UI.CancelledError()
      const memory = yield* Effect.promise(() =>
        prompts.select({
          message: "Long-term memory",
          options: [
            { label: "Ask before saving", value: "ask" as const },
            { label: "Automatically save safe memories", value: "auto-safe" as const },
            { label: "Off", value: "off" as const },
          ],
          initialValue: current.memory,
        }),
      )
      if (prompts.isCancel(memory)) throw new UI.CancelledError()

      update = { name, persona, memory }
      if (id === "companion") {
        const proactive = yield* Effect.promise(() =>
          prompts.confirm({
            message: "Allow proactive care messages? This is opt-in and can be paused at any time.",
            initialValue: current.proactive,
          }),
        )
        if (prompts.isCancel(proactive)) throw new UI.CancelledError()
        update = { ...update, proactive }
      }
      const selected = yield* Effect.promise(() =>
        prompts.confirm({ message: "Use this profile for new sessions?", initialValue: active === id }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      activate = selected
    }

    const result = yield* profiles
      .setup({ id: Profile.ID.make(id!), update, activate })
      .pipe(Effect.catchTag("ProfileNotFoundError", (error) => fail(error.message)))
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    else if (scripted) process.stdout.write(`Configured profile ${result.id}\n`)
    else {
      prompts.log.success(`Profile ${result.name} configured`)
      prompts.outro(activate ? "New sessions will use this profile" : "Done")
    }
  }),
})

const SetupAgentCommand = { ...AgentCreateCommand, command: "agent", describe: "create an agent" }
const SetupMcpCommand = { ...McpAddCommand, command: "mcp [name]", describe: "add an MCP server" }

export const SetupCommand = cmd({
  command: "setup",
  describe: "set up profiles and extensions",
  builder: (yargs) =>
    yargs.command(ProfileSetupCommand).command(SetupAgentCommand).command(SetupMcpCommand).demandCommand(),
  async handler() {},
})

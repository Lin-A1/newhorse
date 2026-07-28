import { EOL } from "os"
import { Effect } from "effect"
import { Capability } from "@/capability"
import { ToolRegistry } from "@/tool/registry"
import { effectCmd } from "../../effect-cmd"

export const CapabilityCommand = effectCmd({
  command: "capability",
  describe: "show redacted capability status for the current workspace",
  handler: Effect.fn("Cli.debug.capability")(function* () {
    const capability = yield* Capability.Service
    const tools = yield* ToolRegistry.Service
    process.stdout.write(JSON.stringify(yield* capability.current({ toolIDs: yield* tools.ids() }), null, 2) + EOL)
  }),
})

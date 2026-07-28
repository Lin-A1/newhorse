import { Effect, Schema } from "effect"
import { Capability } from "@/capability"
import * as Tool from "./tool"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import DESCRIPTION from "./capability.txt"

export const Parameters = Schema.Struct({})

type Metadata = {
  profile: string
  workspace: "project" | "personal"
}

export function make(toolIDs: () => Effect.Effect<readonly string[]>) {
  return Tool.define<typeof Parameters, Metadata, Capability.Service | Agent.Service | Session.Service>(
    "capability",
    Effect.gen(function* () {
      const capability = yield* Capability.Service
      const agents = yield* Agent.Service
      const sessions = yield* Session.Service
      return {
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (_, ctx) =>
          Effect.gen(function* () {
            const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
            const snapshot = yield* capability.current({
              toolIDs: yield* toolIDs(),
              profileID: session.profileID,
              agent: yield* agents.get(ctx.agent),
              permission: session.permission,
            })
            return {
              title: "Capability status",
              metadata: { profile: snapshot.profile.id, workspace: snapshot.workspace.kind },
              output: JSON.stringify(snapshot, null, 2),
            }
          }),
      }
    }),
  )
}

export * as CapabilityTool from "./capability"

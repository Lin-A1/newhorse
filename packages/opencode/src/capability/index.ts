import { LayerNode } from "@newhorse/core/effect/layer-node"
import { PermissionV1 } from "@newhorse/core/v1/permission"
import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { Memory } from "@/memory"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Profile } from "@/profile"
import { Scheduler } from "@/scheduler"
import { Skill } from "@/skill"
import { Wildcard } from "@newhorse/core/util/wildcard"
import { WorkspacePolicy } from "@/control-plane/workspace-policy"

export const Name = Schema.Literals(["read", "edit", "shell", "delegate", "memory", "reminder", "web", "skill"])
export type Name = Schema.Schema.Type<typeof Name>

export const Action = Schema.Literals(["allow", "deny", "ask", "conditional"])
export type Action = Schema.Schema.Type<typeof Action>

export const Entry = Schema.Struct({
  name: Name,
  action: Action,
})
export type Entry = Schema.Schema.Type<typeof Entry>

export const Snapshot = Schema.Struct({
  agent: Schema.String,
  capabilities: Schema.Array(Entry),
})
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

export const UnavailableReason = Schema.Literals([
  "config_disabled",
  "workspace_policy",
  "permission_denied",
  "authentication_required",
  "client_registration_required",
  "runtime_failed",
  "not_configured",
])
export type UnavailableReason = Schema.Schema.Type<typeof UnavailableReason>

export const Availability = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(UnavailableReason),
})

export const Current = Schema.Struct({
  profile: Profile.Info,
  workspace: Schema.Struct({
    id: Schema.optional(Schema.String),
    kind: WorkspacePolicy.Kind,
    contentScope: WorkspacePolicy.Kind,
    source: WorkspacePolicy.Source,
  }),
  agent: Schema.Struct({
    default: Schema.String,
    current: Schema.String,
    items: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        mode: Schema.Literals(["subagent", "primary", "all"]),
      }),
    ),
  }),
  tools: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      action: Action,
    }),
  ),
  mcp: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literals(["connected", "unavailable"]),
      reason: Schema.optional(UnavailableReason),
    }),
  ),
  skills: Schema.Array(Schema.Struct({ name: Schema.String })),
  plugins: Schema.Struct({ loaded: Schema.Int }),
  memory: Schema.Struct({
    policy: Schema.Literals(["off", "ask", "auto-safe"]),
    records: Schema.Int,
    availability: Availability,
  }),
  reminders: Schema.Struct({
    proactive: Schema.Boolean,
    paused: Schema.Boolean,
    scheduled: Schema.Int,
    availability: Availability,
  }),
}).annotate({ identifier: "CapabilityCurrent" })
export type Current = Schema.Schema.Type<typeof Current>

const checks = [
  ["read", ["read"]],
  ["edit", ["edit", "write", "apply_patch", "multi_edit"]],
  ["shell", ["bash"]],
  ["delegate", ["task"]],
  ["memory", ["memory"]],
  ["reminder", ["reminder"]],
  ["web", ["webfetch", "websearch"]],
  ["skill", ["skill"]],
] as const satisfies ReadonlyArray<readonly [Name, readonly string[]]>

function action(permission: readonly string[], ruleset: PermissionV1.Ruleset): Action {
  const values = new Set<PermissionV1.Action>()
  for (const name of permission) {
    const matching = ruleset.filter((rule) => Wildcard.match(name, rule.permission))
    const global = matching.findLastIndex((rule) => rule.pattern === "*")
    if (matching.slice(global + 1).some((rule) => rule.pattern !== "*")) return "conditional"
    values.add(Permission.evaluate(name, "*", ruleset).action)
  }
  return values.size === 1 ? values.values().next().value! : "conditional"
}

function toolAction(id: string, ruleset: PermissionV1.Ruleset): Action {
  return action([Permission.toolPermission(id)], ruleset)
}

function mcpState(status: MCP.Status): { status: "connected" | "unavailable"; reason?: UnavailableReason } {
  if (status.status === "connected") return { status: "connected" }
  if (status.status === "needs_auth") return { status: "unavailable", reason: "authentication_required" }
  if (status.status === "needs_client_registration") {
    return { status: "unavailable", reason: "client_registration_required" }
  }
  if (status.status === "failed") return { status: "unavailable", reason: "runtime_failed" }
  if (status.reason === "personal_workspace") return { status: "unavailable", reason: "workspace_policy" }
  if (status.reason === "config") return { status: "unavailable", reason: "config_disabled" }
  return { status: "unavailable" }
}

export interface Interface {
  readonly inspect: (input: { agent: Agent.Info; permission?: PermissionV1.Ruleset }) => Effect.Effect<Snapshot>
  readonly current: (input: {
    toolIDs: readonly string[]
    profileID?: Profile.ID
    agent?: Agent.Info
    permission?: PermissionV1.Ruleset
  }) => Effect.Effect<Current>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Capability") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const mcp = yield* MCP.Service
    const skills = yield* Skill.Service
    const plugins = yield* Plugin.Service
    const memory = yield* Memory.Service
    const scheduler = yield* Scheduler.Service
    const profiles = yield* Profile.Service

    const inspect: Interface["inspect"] = Effect.fn("Capability.inspect")(function* (input) {
      const ruleset = Agent.effectivePermission(input.agent, input.permission ?? [])
      return {
        agent: input.agent.name,
        capabilities: checks.map(([name, permission]) => ({
          name,
          action: action(permission, ruleset),
        })),
      }
    })

    const current: Interface["current"] = Effect.fn("Capability.current")(function* (input) {
      const [runtime, policy, workspaceID, defaultAgent, agentItems, mcpStatuses, skillItems, pluginItems] =
        yield* Effect.all(
          [
            profiles.runtime(input.profileID).pipe(Effect.orDie),
            WorkspacePolicy.current,
            InstanceState.workspaceID,
            agents.defaultInfo(),
            agents.list(),
            mcp.status(),
            skills.available(),
            plugins.list(),
          ],
          { concurrency: "unbounded" },
        )
      const agent = input.agent ?? defaultAgent
      const ruleset = Agent.effectivePermission(agent, input.permission ?? [])
      const memoryAction = action(["memory"], ruleset)
      const reminderAction = action(["reminder"], ruleset)
      const memoryAvailable = runtime.memory !== "off"
      const reminderAvailable = runtime.proactive && !runtime.proactivePaused
      const [memoryCount, scheduledCount] = yield* Effect.all(
        [
          memoryAction === "deny" || !memoryAvailable
            ? Effect.succeed(0)
            : memory.count({ includeGlobal: true, profileID: runtime.id }),
          reminderAction === "deny"
            ? Effect.succeed(0)
            : scheduler.count({ profileID: runtime.id, status: ["pending", "paused"] }),
        ],
        { concurrency: "unbounded" },
      )

      return {
        profile: {
          id: runtime.id,
          kind: runtime.kind,
          name: runtime.name,
          memory: runtime.memory,
          proactive: runtime.proactive,
        },
        workspace: {
          id: workspaceID,
          kind: policy.kind,
          contentScope: policy.contentScope,
          source: policy.source,
        },
        agent: {
          default: defaultAgent.name,
          current: agent.name,
          items: agentItems
            .filter((item) => item.hidden !== true)
            .map((item) => ({ name: item.name, mode: item.mode })),
        },
        tools: input.toolIDs.toSorted().map((id) => ({ id, action: toolAction(id, ruleset) })),
        mcp: Object.entries(mcpStatuses)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([name, status]) => ({ name, ...mcpState(status) })),
        skills: skillItems
          .filter((item) => Permission.evaluate("skill", item.name, ruleset).action !== "deny")
          .map((item) => ({ name: item.name }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
        plugins: { loaded: pluginItems.length },
        memory: {
          policy: runtime.memory,
          records: memoryCount,
          availability:
            memoryAction === "deny"
              ? { available: false, reason: "permission_denied" as const }
              : memoryAvailable
                ? { available: true }
                : { available: false, reason: "config_disabled" as const },
        },
        reminders: {
          proactive: runtime.proactive,
          paused: runtime.proactivePaused,
          scheduled: scheduledCount,
          availability:
            reminderAction === "deny"
              ? { available: false, reason: "permission_denied" as const }
              : reminderAvailable
                ? { available: true }
                : { available: false, reason: "config_disabled" as const },
        },
      }
    })

    return Service.of({ inspect, current })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, MCP.node, Skill.node, Plugin.node, Memory.node, Scheduler.node, Profile.node],
})

export * as Capability from "./index"

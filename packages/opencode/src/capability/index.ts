import { LayerNode } from "@newhorse/core/effect/layer-node"
import { PermissionV1 } from "@newhorse/core/v1/permission"
import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Wildcard } from "@newhorse/core/util/wildcard"

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

const checks = [
  ["read", ["read"]],
  ["edit", ["edit", "write", "apply_patch"]],
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

export interface Interface {
  readonly inspect: (input: { agent: Agent.Info; permission?: PermissionV1.Ruleset }) => Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/Capability") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    inspect: Effect.fn("Capability.inspect")(function* (input) {
      const ruleset = Agent.effectivePermission(input.agent, input.permission ?? [])
      return {
        agent: input.agent.name,
        capabilities: checks.map(([name, permission]) => ({
          name,
          action: action(permission, ruleset),
        })),
      }
    }),
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as Capability from "./index"

import { PermissionV1 } from "@newhorse/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. A hard `task` deny: spawned subagents cannot delegate further
 *    (delegation permission sinks one level down — oh-my-opencode
 *    delegate_task:false). Nesting depth is governed by `subagent_depth`.
 * 3. Default `todowrite` denies if the subagent's own ruleset
 *    doesn't already permit it.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    { permission: "task" as const, pattern: "*" as const, action: "deny" as const },
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

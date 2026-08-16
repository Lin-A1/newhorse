import { Agent } from "./agent"

/**
 * Render the <available_subagents> delegation guidance injected into the
 * stable system prefix. Mirrors oh-my-opencode's buildDelegationTable /
 * buildKeyTriggersSection: domain → agent → trigger rows plus key triggers,
 * so the main agent can self-dispatch without user steering.
 */
export function buildAgentGuidance(
  agents: Agent.Info[],
  opts: { planEnter?: boolean } = {},
): string | undefined {
  const delegatable = agents
    .filter((a) => a.mode !== "primary" && a.hidden !== true && a.subagent_meta?.triggers?.length)
    .toSorted((a, b) => a.name.localeCompare(b.name))
  if (delegatable.length === 0 && !opts.planEnter) return

  const rows = delegatable.flatMap((agent) =>
    (agent.subagent_meta?.triggers ?? []).map(
      (trigger) => `| ${trigger.domain} | \`${agent.name}\` | ${trigger.trigger} |`,
    ),
  )
  const keyTriggers = delegatable
    .map((a) => a.subagent_meta?.key_trigger)
    .filter((t): t is string => Boolean(t))

  return [
    "<available_subagents>",
    "You can delegate work to subagents via the task tool. Subagents are STATELESS - they only know what you tell them.",
    ...(rows.length > 0
      ? [
          "Delegation table:",
          "| Domain | Delegate To | Trigger |",
          "|--------|-------------|---------|",
          ...rows,
        ]
      : []),
    ...(keyTriggers.length > 0 ? ["", "Key triggers (check BEFORE delegating):", ...keyTriggers.map((t) => `- ${t}`)] : []),
    ...(opts.planEnter
      ? [
          "",
          "For complex or cross-module tasks, use the plan_enter tool to switch into plan mode first; plan mode explores, asks questions, and writes a plan file, then hands back via plan_exit.",
        ]
      : []),
    "</available_subagents>",
  ].join("\n")
}

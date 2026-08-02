import { Schema } from "effect"
import type { WorkspacePolicy } from "@/control-plane/workspace-policy"

export const Decision = Schema.Literals(["allow", "ask", "deny"])
export type Decision = Schema.Schema.Type<typeof Decision>

export const Reason = Schema.Literals([
  "same_scope",
  "user_global_preference_only",
  "relationship_personal_only",
  "project_to_personal_requires_grant",
  "personal_to_project_requires_grant",
  "extension_personal_opt_in_required",
  "workspace_policy",
])
export type Reason = Schema.Schema.Type<typeof Reason>

export const Action = Schema.Literals([
  "memory.save",
  "memory.retrieve",
  "continuity.propose",
  "continuity.inject",
  "extension.load",
  "capability.explain",
])
export type Action = Schema.Schema.Type<typeof Action>

export type ContentScope = WorkspacePolicy.Kind | "user_global" | "relationship"

export type ContentFlowInput = {
  action: Action
  source: ContentScope
  destination: ContentScope
  kind?: string
  personalOptIn?: boolean
}

export type Result = {
  decision: Decision
  reason: Reason
}

const allow = (reason: Reason = "same_scope"): Result => ({ decision: "allow", reason })
const ask = (reason: Reason): Result => ({ decision: "ask", reason })
const deny = (reason: Reason): Result => ({ decision: "deny", reason })

export function decideContentFlow(input: ContentFlowInput): Result {
  if (input.action === "capability.explain") return allow("workspace_policy")
  if (input.action === "extension.load") {
    if (input.source === "personal" || input.destination === "personal") {
      return input.personalOptIn ? allow("same_scope") : deny("extension_personal_opt_in_required")
    }
    return allow()
  }
  if (input.destination === "user_global") {
    return input.kind === "preference" ? allow("user_global_preference_only") : deny("user_global_preference_only")
  }
  if (input.source === "relationship" || input.destination === "relationship") {
    return input.source === "personal" || input.destination === "personal"
      ? allow("relationship_personal_only")
      : deny("relationship_personal_only")
  }
  if (input.source === input.destination) return allow()
  if (input.source === "project" && input.destination === "personal") return ask("project_to_personal_requires_grant")
  if (input.source === "personal" && input.destination === "project") return ask("personal_to_project_requires_grant")
  return deny("workspace_policy")
}

export * as TrustPolicy from "./index"

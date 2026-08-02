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
  "memory.propose",
  "continuity.propose",
  "continuity.approve",
  "continuity.inject",
  "continuity.revoke",
  "reminder.create",
  "reminder.deliver",
  "extension.load",
  "tool.load",
  "skill.load",
  "mcp.connect",
  "capability.explain",
])
export type Action = Schema.Schema.Type<typeof Action>

export type ContentScope = WorkspacePolicy.Kind | "user_global" | "relationship"
export const ContentScopeSchema = Schema.Literals(["project", "personal", "user_global", "relationship"])
export type ContentScopeSchema = Schema.Schema.Type<typeof ContentScopeSchema>

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

/**
 * Pure content-flow decision. `source`/`destination` MUST be derived by the
 * caller from trusted persisted state (Session, Profile, Workspace metadata,
 * Content Scope). Client-supplied profile/workspace/session fields are never
 * an authority.
 */
export function decideContentFlow(input: ContentFlowInput): Result {
  if (input.action === "capability.explain") return allow("workspace_policy")
  if (input.destination === "user_global") {
    return input.kind === "preference" ? allow("user_global_preference_only") : deny("user_global_preference_only")
  }
  if (input.source === "relationship" || input.destination === "relationship") {
    return input.source === "personal" || input.destination === "personal"
      ? allow("relationship_personal_only")
      : deny("relationship_personal_only")
  }
  if (
    input.action === "extension.load" ||
    input.action === "tool.load" ||
    input.action === "skill.load" ||
    input.action === "mcp.connect"
  ) {
    if (input.source === "personal" || input.destination === "personal") {
      return input.personalOptIn ? allow("same_scope") : deny("extension_personal_opt_in_required")
    }
    return allow()
  }
  if (input.source === input.destination) return allow()
  if (input.source === "project" && input.destination === "personal") return ask("project_to_personal_requires_grant")
  if (input.source === "personal" && input.destination === "project") return ask("personal_to_project_requires_grant")
  return deny("workspace_policy")
}

const strictness: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 }

/**
 * Monotonic user-config application. User configuration may only tighten a
 * platform decision (allow -> ask/deny, ask -> deny). It can never relax a
 * platform `deny` into `allow`/`ask`.
 */
export function applyUserPolicy(base: Decision, user: Decision | undefined): Decision {
  if (user === undefined) return base
  return strictness[user] >= strictness[base] ? user : base
}

/**
 * Content-free policy audit record. It never carries Memory content, Reminder
 * bodies, Continuity purpose/summary, prompt text, file paths, headers, env, or
 * secrets. `actor` is a minimal, opaque identifier only.
 */
export const PolicyAudit = Schema.Struct({
  id: Schema.String,
  time: Schema.Number,
  action: Action,
  source: ContentScopeSchema,
  destination: ContentScopeSchema,
  decision: Decision,
  reason: Reason,
  actor: Schema.String,
})
export type PolicyAudit = Schema.Schema.Type<typeof PolicyAudit>

export function auditDecision(input: {
  id: string
  time?: number
  action: Action
  source: ContentScope
  destination: ContentScope
  decision: Decision
  reason: Reason
  actor: string
}): PolicyAudit {
  return {
    id: input.id,
    time: input.time ?? Date.now(),
    action: input.action,
    source: input.source,
    destination: input.destination,
    decision: input.decision,
    reason: input.reason,
    actor: input.actor,
  }
}

export * as TrustPolicy from "./index"

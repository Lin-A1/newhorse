import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Identifier } from "@newhorse/core/id/id"
import { Wildcard } from "@newhorse/core/util/wildcard"
import type { PermissionV1 } from "@newhorse/core/v1/permission"
import { Context, Effect, Layer } from "effect"
import { PolicyAuditStore } from "./policy-audit"
import type { Action, ContentScope, Decision, PolicyAudit, Reason } from "./policy-audit"

export { PolicyAuditStore } from "./policy-audit"
export { Action, ContentScopeSchema, Decision, Page, PolicyAudit, Reason } from "./policy-audit"
export type { ContentScope } from "./policy-audit"

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
 * Map the user's configured permission ruleset to a tightening decision for a
 * content-flow action. Only a wildcard `"*"` rule on the exact action name
 * applies (e.g. `permission: { "memory.save": "deny" }`). A user `allow` never
 * tightens and returns `undefined`.
 */
export function userDecision(ruleset: PermissionV1.Ruleset | undefined, action: Action): Decision | undefined {
  if (!ruleset || ruleset.length === 0) return undefined
  const rule = ruleset.findLast(
    (item) => Wildcard.match(action, item.permission) && Wildcard.match("*", item.pattern),
  )
  if (!rule) return undefined
  if (rule.action === "deny") return "deny"
  if (rule.action === "ask") return "ask"
  return undefined
}

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

export interface DecideInput {
  action: Action
  source: ContentScope
  destination: ContentScope
  kind?: string
  personalOptIn?: boolean
  userRuleset?: PermissionV1.Ruleset
  actor: string
}

export interface Interface {
  readonly decide: (input: DecideInput) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/TrustPolicy") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const audits = yield* PolicyAuditStore.Service

    const decide: Interface["decide"] = Effect.fn("TrustPolicy.decide")(function* (input) {
      const flow = decideContentFlow({
        action: input.action,
        source: input.source,
        destination: input.destination,
        kind: input.kind,
        personalOptIn: input.personalOptIn,
      })
      const decision = applyUserPolicy(flow.decision, userDecision(input.userRuleset, input.action))
      // Memory retrieval happens on the hot prompt path; skip auditing the
      // routine same-scope read so the content-free trail stays meaningful.
      const shouldAudit = !(
        input.action === "memory.retrieve" && decision === "allow" && flow.reason === "same_scope"
      )
      if (shouldAudit) {
        yield* audits.record(
          auditDecision({
            id: Identifier.ascending("policyAudit"),
            action: input.action,
            source: input.source,
            destination: input.destination,
            decision,
            reason: flow.reason,
            actor: input.actor,
          }),
        )
      }
      return { decision, reason: flow.reason }
    })

    return Service.of({ decide })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [PolicyAuditStore.node],
})

export * as TrustPolicy from "./index"

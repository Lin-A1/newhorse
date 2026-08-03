import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export type PolicyAuditAction =
  | "memory.save"
  | "memory.retrieve"
  | "memory.propose"
  | "continuity.propose"
  | "continuity.approve"
  | "continuity.inject"
  | "continuity.revoke"
  | "reminder.create"
  | "reminder.deliver"
  | "extension.load"
  | "tool.load"
  | "skill.load"
  | "mcp.connect"
  | "capability.explain"
export type PolicyAuditScope = "project" | "personal" | "user_global" | "relationship"
export type PolicyAuditDecision = "allow" | "ask" | "deny"
export type PolicyAuditReason =
  | "same_scope"
  | "user_global_preference_only"
  | "relationship_personal_only"
  | "project_to_personal_requires_grant"
  | "personal_to_project_requires_grant"
  | "extension_personal_opt_in_required"
  | "workspace_policy"

export const PolicyAuditTable = sqliteTable(
  "policy_audit",
  {
    id: text().primaryKey(),
    time: integer().notNull(),
    action: text().$type<PolicyAuditAction>().notNull(),
    source: text().$type<PolicyAuditScope>().notNull(),
    destination: text().$type<PolicyAuditScope>().notNull(),
    decision: text().$type<PolicyAuditDecision>().notNull(),
    reason: text().$type<PolicyAuditReason>().notNull(),
    actor: text().notNull(),
  },
  (table) => [
    index("policy_audit_time_idx").on(table.time),
    index("policy_audit_action_idx").on(table.action, table.time),
  ],
)

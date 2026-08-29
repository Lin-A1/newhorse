import type { Tool } from "@newhorse/core"

/**
 * Agent role resolution (Phase 4) — borrowed from Codex's `agent_type` role
 * overlay (`core/src/agent/role.rs`): a named agent is a RESTRICTIVE overlay
 * over the parent's configuration. It can narrow tools, set a model, and
 * contribute a system body — never widen the parent's authority.
 *
 * The definition itself comes from the plugin seam (`AgentCapability`); this
 * module is the pure resolution function (no branching chains, no if/switch
 * on concrete types).
 */

export interface AgentDefinition {
  readonly name: string
  readonly description?: string
  /** System body (specialist instructions) injected into the child's context. */
  readonly body?: string
  /** Whitelist of tool names. Absent = inherit ALL parent tools (no narrowing). */
  readonly allowedTools?: readonly string[]
  /** Role key (costDown / scheduling reference, e.g. "researcher"). */
  readonly role?: string
  /** Default model when the caller does not override. */
  readonly model?: string
}

/** Resolve a named agent's effective tools: parent tools ∩ allowedTools. */
export function resolveAgentTools(parentTools: readonly Tool[], allowedTools?: readonly string[]): Tool[] {
  if (!allowedTools || allowedTools.length === 0) return [...parentTools]
  const allowed = new Set(allowedTools)
  return parentTools.filter((t) => allowed.has(t.name))
}

/** Resolve the effective model: explicit > agent.model > inherited. */
export function resolveAgentModel(agent?: AgentDefinition, explicit?: string, inherited?: string, costDownModel?: string): string | undefined {
  if (explicit) return explicit
  if (agent?.model) return agent.model
  if (costDownModel) return costDownModel
  return inherited
}

export interface ResolvedAgent {
  readonly id: string
  readonly model: string
  readonly body?: string
  readonly tools: readonly Tool[]
}

/** Full resolve: given a definition + parent context, produce the child's agent. */
export function resolveAgent(def: AgentDefinition | undefined, parent: { tools: readonly Tool[]; model: string }, explicitModel?: string): ResolvedAgent {
  return {
    id: def?.name ?? "agent",
    model: resolveAgentModel(def, explicitModel, parent.model) ?? parent.model,
    body: def?.body,
    tools: resolveAgentTools(parent.tools, def?.allowedTools),
  }
}

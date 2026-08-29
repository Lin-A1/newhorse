import type { Initiator, Tool, ToolCtx, SessionRow } from "@newhorse/core"
import type { SessionRegistry } from "@newhorse/core"

/**
 * Butler tools (M2b). These are ordinary `Tool`s whose `execute` receives a
 * `ToolCtx` carrying the trusted `caller` (injected by the loop). Each tool
 * enforces its own authorization inside `execute` — reading `ctx.caller` (never
 * the model's payload) and `ctx.registry` — and appends an audit entry for both
 * allowed and denied decisions.
 *
 * The authority model (see specs/v2/m2b-butler-authority.md):
 *   - list_sessions: any caller allowed (observation).
 *   - interrupt: butler wide (any session), parent scoped to direct children,
 *     user any. targetRequired.
 *   - spawn_agent: any caller may spawn; spawner becomes the parent.
 *   - send_to_session: default-deny; only user, or parent to its direct child.
 *     targetRequired.
 */
export interface ButlerDeps {
  readonly registry: SessionRegistry
  readonly appendAudit: (entry: { actorKind: "user" | "butler" | "parent"; actorId: string; op: string; targetSessionId?: string; outcome: "allowed" | "denied"; reason?: string }) => Promise<void>
}

interface Decision {
  allowed: boolean
  reason?: string
}

/** Common helper: resolve target, short-circuit unknown, authorize, audit. */
async function guarded(
  deps: ButlerDeps,
  ctx: ToolCtx,
  op: string,
  targetId: string | undefined,
  needsTarget: boolean,
  authorize: (caller: Initiator, target?: SessionRow) => Decision,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const actorId = ctx.sessionId ?? (ctx.caller.kind === "user" ? "user" : ctx.caller.sessionId)

  let target: SessionRow | undefined
  if (targetId) {
    // Refresh so a just-spawned child is visible (registry is a lazy projection).
    await deps.registry.refresh()
    target = await deps.registry.get(targetId)
  }

  // needsTarget tools: a missing/unknown target is denied before authorize.
  const decision = needsTarget && !target ? { allowed: false, reason: "unknown target" } : authorize(ctx.caller, target)
  await deps.appendAudit({ actorKind: ctx.caller.kind, actorId, op, targetSessionId: targetId, outcome: decision.allowed ? "allowed" : "denied", reason: decision.reason })
  if (!decision.allowed) throw new Error(`denied: ${decision.reason ?? "unknown target"}`)
  return run()
}

function requireCtx(ctx?: ToolCtx): ToolCtx {
  if (!ctx) throw new Error("butler tool missing ctx")
  return ctx
}

/** Build the four butler tools as a registry-backed list. */
export function createButlerTools(deps: ButlerDeps): Tool[] {
  return [
    {
      name: "list_sessions",
      description: "List sessions (observational, read-only).",
      execute: async (input: unknown, ctx?: ToolCtx) => {
        requireCtx(ctx)
        // The registry index is lazily hydrated and only refreshed when a target
        // is present. The butler's whole purpose is to observe the session tree,
        // so a freshly spawned child (already durable in the store) must be
        // visible here — refresh before listing, matching the app-level view.
        await deps.registry.refresh()
        return deps.registry.list(input as never)
      },
    },
    {
      name: "interrupt",
      description: "Interrupt a running session. Butler may interrupt any; a parent only its direct child.",
      execute: async (input: unknown, ctx?: ToolCtx) => {
        const c = requireCtx(ctx)
        const targetId = (input as { target?: string }).target
        return guarded(deps, c, "interrupt", targetId, true, (caller, target) => {
          if (caller.kind === "user") return { allowed: true }
          if (caller.kind === "butler") return { allowed: true }
          return target && target.parentId === caller.sessionId ? { allowed: true } : { allowed: false, reason: "only your direct child session" }
        }, async () => {
          const res = await c.interruptTarget?.(targetId!)
          // Report the hub's actual outcome; never claim an effect a stub
          // did not apply.
          return { authorization: "allowed", targetId, implemented: res?.implemented ?? false, pending: res?.pending ?? true }
        })
      },
    },
    {
      name: "spawn_agent",
      description: "Spawn a new agent session; the spawner becomes its parent.",
      execute: async (input: unknown, ctx?: ToolCtx) => {
        const c = requireCtx(ctx)
        const model = (input as { model?: string }).model
        const parentId = c.caller.kind === "user" ? "user" : c.caller.sessionId
        // spawn has no target; always allowed, but MUST be audited — appendAudit
        // is required (audit is not optional for butler actions).
        if (!c.appendAudit) throw new Error("butler tool missing appendAudit")
        const child = await c.spawnFrom?.(parentId, model)
        await c.appendAudit({ actorKind: c.caller.kind, actorId: c.sessionId ?? parentId, op: "spawn_agent", targetSessionId: child, outcome: "allowed", reason: undefined })
        return { authorization: "allowed", model, parentId, childSessionId: child, implemented: child !== undefined }
      },
    },
    {
      name: "send_to_session",
      description: "Send a message to another session. Default-deny: only user, or a parent to its direct child.",
      execute: async (input: unknown, ctx?: ToolCtx) => {
        const c = requireCtx(ctx)
        const targetId = (input as { target?: string }).target
        const content = (input as { content?: string }).content
        return guarded(deps, c, "send_to_session", targetId, true, (caller, target) => {
          if (caller.kind === "user") return { allowed: true }
          if (caller.kind === "parent") return target && target.parentId === caller.sessionId ? { allowed: true } : { allowed: false, reason: "only your direct child session" }
          return { allowed: false, reason: "butler requires explicit user authorization" }
        }, async () => {
          const res = await c.sendToTarget?.(targetId!, content ?? "")
          return { authorization: "allowed", targetId, content, implemented: res?.implemented ?? false, pending: res?.pending ?? true }
        })
      },
    },
  ]
}

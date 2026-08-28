import type { Decision, ExecPolicy } from "@newhorse/schema"

/**
 * M4 execpolicy: the deny-all fallback policy owned by core (specs/v2/m4-execpolicy.md).
 *
 * The engine must never let a tool run unaudited. When the runtime does not
 * inject a richer execpolicy (via toolCtx), the turn loop falls back to this
 * deny-all policy so bash/write/edit fail closed instead of running bare. Core
 * keeps this because core cannot import runtime; this only depends on schema.
 *
 * `approve` is intentionally absent — a deny-all policy has nothing to prompt
 * for, so a `prompt` (if it ever surfaced) would resolve to forbid via the
 * fail-closed rule in the tools.
 */
export const denyAllExecPolicy: ExecPolicy = {
  decide: (): Decision => "forbid",
  decidePath: (): Decision => "forbid",
}

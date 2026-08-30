/**
 * M4 execpolicy: the tool-layer authorization axis + rule vocabulary (types only).
 *
 * This is a pure type module (no runtime). The policy engine lives in
 * `runtime/src/tools/execpolicy.ts`; the deny-all fallback lives in `core`.
 * Both return the same `ExecPolicy` structural type defined here, so the
 * dependency direction stays core → schema and runtime → schema (no reverse).
 *
 * Model (specs/v2/m4-execpolicy.md):
 *   - `Decision = allow < prompt < forbid`, multiple rules take the strictest
 *     (`max`), and the dangerous-command heuristic is ALWAYS the floor (a rule
 *     can never upgrade a dangerous action to allow).
 *   - Command rules match argv prefix by LONGEST-prefix-first; path rules match
 *     a normalized path segment.
 *   - `approve?` is the single interactive gate (transport-injected). With no
 *     approve callback (DAG / non-interactive SDK), a `prompt` resolves to
 *     `forbid` (fail-closed).
 */

/** The strictness ordering: forbid > prompt > allow. */
export type Decision = "allow" | "prompt" | "forbid"

/** A rule primitive (all registered on a seam, not if/switch chains). */
export type ExecRule =
  | { readonly type: "prefix_rule"; readonly pattern: readonly string[]; readonly decision: Decision; readonly reason?: string }
  | { readonly type: "network_rule"; readonly host: string; readonly protocol: "http" | "https"; readonly decision: Decision; readonly reason?: string }
  | { readonly type: "path_rule"; readonly prefix: string; readonly decision: Decision; readonly reason?: string }
  | { readonly type: "shell_wrapper"; readonly decision: Decision; readonly reason?: string }
  | { readonly type: "host_executable"; readonly path: string; readonly decision: Decision; readonly reason?: string }

/** An interactive approval request (command or path write). */
export interface ApprovalRequest {
  readonly id: string
  readonly kind: "command" | "path" | "mode"
  readonly target: string
  readonly decision: Decision
  readonly reason?: string
}

/**
 * ExecPolicy: the injected tool-layer authorization axis. Always present at
 * runtime (loop fills a deny-all fallback when not provided). `decide` reads
 * `process.platform` at call time so it matches the shell actually invoked.
 */
export interface ExecPolicy {
  /** Decide the decision for a shell command (model's raw string). */
  readonly decide: (cmd: string) => Decision
  /** Decide the decision for a path write (write/edit target). */
  readonly decidePath: (path: string) => Decision
  /** Interactive gate. Absent → prompt resolves to forbid (fail-closed). */
  readonly approve?: (req: ApprovalRequest) => Promise<boolean>
}

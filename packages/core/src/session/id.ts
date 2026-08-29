/**
 * Deterministic per-workspace session identifier.
 *
 * Long-horizon (goal #2): a session should re-attach to its prior log after a
 * restart without forcing the user to name it. Deriving a stable id from the
 * workspace path is a DOMAIN rule, not a transport concern, so it lives in core
 * and every transport (CLI / web / desktop / SDK) benefits from it instead of
 * the CLI re-deriving a workspace hash that ignores other transports.
 */
export function stableSessionId(workspace: string): string {
  let hash = 0
  for (const c of workspace) hash = (hash * 31 + c.charCodeAt(0)) | 0
  return `ws-${(hash >>> 0).toString(16)}`
}

import { resolve } from "node:path"

/**
 * Deterministic per-workspace session identifier.
 *
 * Long-horizon (goal #2): a session should re-attach to its prior log after a
 * restart without forcing the user to name it. Deriving a stable id from the
 * workspace path is a DOMAIN rule, not a transport concern, so it lives in core
 * and every transport (CLI / web / desktop / SDK) benefits from it instead of
 * the CLI re-deriving a workspace hash that ignores other transports.
 *
 * The workspace is normalized (resolved to an absolute, separated path) before
 * hashing so a trailing separator or relative form on one run does not silently
 * fork a fresh session id on the next — the re-attach guarantee depends on the
 * id being stable across runs regardless of how the caller spelled the path.
 */
export function stableSessionId(workspace: string): string {
  const normalized = resolve(workspace)
  let hash = 0
  for (const c of normalized) hash = (hash * 31 + c.charCodeAt(0)) | 0
  return `ws-${(hash >>> 0).toString(16)}`
}

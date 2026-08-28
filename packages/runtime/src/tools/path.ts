import { realpath, stat } from "node:fs/promises"
import { basename, dirname, resolve, sep } from "node:path"

/**
 * Workspace sandbox for the builtin fs tools. This is the SINGLE shared path
 * guard: every fs tool resolves user-supplied paths through it, and none may
 * roll its own containment check (M3.5 §2.1). It enforces three layers so the
 * "prefix check" cannot be bypassed:
 *
 *   1. Normalization — `resolve` folds `..` and absolute inputs. URL-encoding
 *      (`%2e%2e`) is not an attack surface here because tool input is a JSON
 *      string, never URL-decoded.
 *   2. realpath — `resolve` is purely lexical and does not follow symlinks, so a
 *      workspace-internal symlink/junction pointing outside (common in
 *      node_modules) would pass the lexical prefix check. We resolve the real
 *      path of the deepest existing ancestor and re-append any nonexistent tail
 *      (write targets may not exist yet; 8.3 short names like `REPO~1` are
 *      covered). Residual TOCTOU risk is accepted and documented.
 *   3. Containment — never a bare `startsWith(root)`: `G:\repo` is a prefix of
 *      `G:\repo-evil\a.txt`. We require `p === root || p.startsWith(root + sep)`
 *      with case-folding on win32 (drive letter `g:` vs `G:`).
 */
export async function resolveInWorkspace(root: string, p: string): Promise<string> {
  if (typeof p !== "string" || p.length === 0) throw pathError("path must be a non-empty string")

  const rootAbs = resolve(root)
  const candidate = resolve(rootAbs, p)
  if (/^\\\\\?\\/.test(candidate)) throw pathError("device path is not allowed")

  // Resolve real paths (following symlinks/junctions) of both the root and the
  // candidate so containment is judged on real paths. The workspace root always
  // exists; the candidate may not (write targets).
  const realRoot = await realPathOf(rootAbs)
  const realCandidate = await realPathOf(candidate)

  if (!isContained(realRoot, realCandidate)) throw pathError("path escapes the workspace")
  return realCandidate
}

/** Real path of `p`, even if `p` doesn't exist yet: realpath the deepest
 * existing ancestor and re-append the (possibly nonexistent) tail. */
async function realPathOf(p: string): Promise<string> {
  const tail: string[] = []
  let cur = p
  for (let i = 0; i < 64; i++) {
    if (await exists(cur)) {
      const base = await realpath(cur)
      return tail.length === 0 ? base : resolve(base, ...tail.reverse())
    }
    const parent = dirname(cur)
    if (parent === cur) return p
    tail.push(basename(cur))
    cur = parent
  }
  return p
}

/** Whether `candidate` is inside `root` with boundary + case-folding. */
function isContained(root: string, candidate: string): boolean {
  const a = normalize(root)
  const b = normalize(candidate)
  if (a === b) return true
  return b.startsWith(a + sep)
}

/** Case-fold on win32 (drive letter and path casing are case-insensitive). */
function normalize(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p
}

function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false)
}

function pathError(message: string): Error {
  const e = new Error(message) as Error & { code: string }
  e.code = "path-escape"
  return e
}

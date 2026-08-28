import { lstat, readdir, stat } from "node:fs/promises"
import { basename, join, relative } from "node:path"

/** Default directories excluded from list/search because they are either huge
 * or contain binary/noise. Keeps real-repo search fast and clean (M3.5 §2.4). */
export const EXCLUDED_DIRS = new Set([".git", "node_modules", ".newhorse", ".opencode", "dist", "build", "coverage"])

export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff",
  "pdf", "zip", "gz", "tar", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp4", "mp3", "wav", "ogg", "flac",
  "exe", "dll", "so", "dylib", "bin", "class", "jar", "wasm",
])

export interface ToolFailure {
  readonly error: string
}

/** A read-only error that the model can self-correct on (M3.5 §2.4): file
 * missing, permission denied, etc. Returned as data, never thrown as a crash. */
export function fail(message: string): ToolFailure & { readonly isError?: never } {
  return { error: message }
}

/** Whether a path is likely binary based on its extension. */
export function isLikelyBinary(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return BINARY_EXTENSIONS.has(ext)
}

/** Whether a path represents a directory entry to skip during traversal. */
export function isExcluded(base: string): boolean {
  return EXCLUDED_DIRS.has(base)
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** Walker options with sensible defaults for real repos. */
export interface WalkOptions {
  /** Max files to collect before bailing (truncation). */
  readonly limit?: number
  /** Extra directory names to exclude, in addition to EXCLUDED_DIRS. */
  readonly extraExcludes?: readonly string[]
}

/**
 * Recursively collect file paths under `root`, excluding noisy/binary entries.
 * Skips `.git`, node_modules, dist/build, and binary extensions by default so a
 * glob/grep over a real repository stays fast and clean. `limit` caps the walk
 * to avoid flooding context (returns `truncated`).
 */
export async function collectFiles(root: string, opts: WalkOptions = {}): Promise<{ files: string[]; truncated: boolean }> {
  const limit = Math.max(1, opts.limit ?? 5000)
  const files: string[] = []
  const excludes = new Set(EXCLUDED_DIRS)
  for (const e of opts.extraExcludes ?? []) excludes.add(e)
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (files.length >= limit) {
      truncated = true
      return
    }
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (files.length >= limit) {
        truncated = true
        return
      }
      if (excludes.has(name)) continue
      const full = join(dir, name)
      // Use lstat (not stat) so a symlink/junction is recognized as a link and
      // NEVER followed into (or enumerated from) a location outside the walk
      // root. A workspace-internal symlink pointing outward would otherwise let
      // list/search read files outside the workspace — a sandbox escape
      // (M3.5 §2.1). We skip links entirely: they represent "elsewhere", not a
      // workspace file.
      let isLink = false
      try {
        isLink = (await lstat(full)).isSymbolicLink()
      } catch {
        continue
      }
      if (isLink) continue
      let isDir = false
      try {
        isDir = (await stat(full)).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        await walk(full)
      } else {
        if (isLikelyBinary(name)) continue
        files.push(full)
      }
    }
  }

  await walk(root)
  return { files, truncated }
}

/** Convert a path into a forward-slash workspace-relative display path. */
export function toRel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/")
}

/**
 * Glob match that is case-insensitive on win32 (mirrors `resolveInWorkspace`'s
 * case-fold) so list/search see the same casing semantics that read/write do.
 * Bun.Glob's `caseInsensitive` does NOT apply to literal extensions, so we fold
 * the pattern and the target ourselves and match on the lower-cased pair. On
 * POSIX we match as-is. `glob` is optional and lets a caller reuse a pre-built
 * glob on POSIX (ignored on win32 where we rebuild a folded one).
 */
export function globMatch(pattern: string, rel: string, glob?: Bun.Glob): boolean {
  if (process.platform !== "win32") return (glob ?? new Bun.Glob(pattern)).match(rel)
  const g = new Bun.Glob(pattern.toLowerCase())
  return g.match(rel.toLowerCase())
}

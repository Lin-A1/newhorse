import { readFile, stat, realpath } from "node:fs/promises"
import { dirname, join, isAbsolute, relative, resolve } from "node:path"

/**
 * Workspace awareness: discover ambient AGENTS.md files and expose them as a
 * model-visible context source.
 *
 * The runtime treats AGENTS.md (and upward-project ones) as ambient context the
 * same way project instructions shape behavior — discovered automatically from
 * the session location, observed for changes, and admitted as model-visible
 * context. A workspace AGENTS.md is never privileged over the engine's own; it
 * is the fallback/default when no project one exists.
 *
 * "model-visible ⟺ logged": these files are read from disk and returned to the
 * caller for model-visible assembly; they should be recorded in the session log
 * before being shown (see the turn loop's system-context composition).
 */
export interface ContextDocument {
  readonly path: string
  readonly text: string
  readonly depth: number
}

/**
 * Discover AGENTS.md from `startPath` upward to the project root (inclusive),
 * returning the deepest (closest to the session) files first. Traversal is
 * contained within the given root; it never escapes upward past it.
 */
export async function discoverWorkspaceContext(startPath: string, root?: string): Promise<ContextDocument[]> {
  const startAbsolute = isAbsolute(startPath) ? startPath : join(process.cwd(), startPath)
  const startDir = await isDir(startAbsolute) ? startAbsolute : dirname(startAbsolute)
  const rootDir = root ? (isAbsolute(root) ? root : join(process.cwd(), root)) : process.cwd()

  const docs: ContextDocument[] = []
  let current = startDir
  let depth = 0
  const seen = new Set<string>()

  // Walk upward until we pass the root (or hit the filesystem root).
  while (true) {
    if (!(current === rootDir || (await inside(current, rootDir)))) break
    const candidate = join(current, "AGENTS.md")
    if (!seen.has(candidate)) {
      seen.add(candidate)
      const text = await readIfFile(candidate)
      if (text !== undefined) docs.push({ path: candidate, text, depth })
    }
    depth += 1
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return docs
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function readIfFile(path: string): Promise<string | undefined> {
  try {
    const s = await stat(path)
    if (!s.isFile()) return undefined
    return readFile(path, "utf8")
  } catch {
    return undefined
  }
}

async function inside(candidate: string, root: string): Promise<boolean> {
  // realpath-normalize both sides so Windows casing/symlinks don't break the
  // containment check, then compare with a relative path.
  try {
    const [rel, r] = await Promise.all([realpath(candidate), realpath(root)])
    if (rel === r) return true
    const p = relative(r, rel)
    return p !== "" && !p.startsWith("..") && !isAbsolute(p)
  } catch {
    return false
  }
}

/** Compose discovered AGENTS.md documents into a single system-context block. */
export function composeSystemContext(docs: readonly ContextDocument[]): string {
  // Deepest (closest to session) first; project-level last. Engine AGENTS.md is
  // the fallback when no project doc exists.
  const sorted = [...docs].sort((a, b) => a.depth - b.depth)
  const sections = sorted.map((d) => `## ${d.path}\n\n${d.text.trim()}`)
  return sections.length > 0 ? sections.join("\n\n") : ""
}

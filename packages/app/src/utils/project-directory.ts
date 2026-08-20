import type { Project } from "@newhorse/sdk/v2/client"

type KnownProject = { worktree?: string }

/**
 * Resolve a directory a new session can be created in for a server that has no
 * locally-known projects (e.g. a fresh browser connected over LAN). Prefer the
 * persisted project list, then the server's most recently used project, then
 * the server's default working directory. Returns undefined only when the
 * server itself has no directory to offer.
 */
export function defaultProjectDirectory(input: {
  known: ReadonlyArray<KnownProject>
  projects: ReadonlyArray<Project>
  serverDirectory?: string
}): string | undefined {
  const known = input.known.find((project) => !!project.worktree)?.worktree
  if (known) return known
  const recent = [...input.projects]
    .filter((project) => !!project.worktree)
    .sort((a, b) => (b.time.updated ?? b.time.created ?? 0) - (a.time.updated ?? a.time.created ?? 0))[0]?.worktree
  if (recent) return recent
  return input.serverDirectory || undefined
}

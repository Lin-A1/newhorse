import { resolveInWorkspace } from "./path"
import { fail, collectFiles, toRel, globMatch } from "./common"
import type { Tool } from "@newhorse/core"

const DEFAULT_LIMIT = 200

/**
 * List files matching a glob pattern under the workspace (e.g. `**`/`*.ts`).
 * Results are capped to avoid flooding context on huge repos, and traversal
 * excludes `.git`/node_modules/binary files. The workspace root is injected so
 * the model always knows what is in scope.
 */
export function createListTool(workspace: string): Tool {
  return {
    name: "list",
    description: `List files matching a glob pattern under the workspace (e.g. "**/*.ts"). Path is under the workspace root: ${workspace}`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'Glob pattern, e.g. "**/*.ts", "src/*.ts". Use "**" for recursive.' },
        path: { type: "string", description: "Base directory to start from (relative to workspace root)." },
        limit: { type: "number", description: `Max entries to return (default ${DEFAULT_LIMIT}).` },
      },
      required: ["pattern"],
    },
    execute: async (input: unknown) => {
      const { pattern, path, limit } = (input ?? {}) as { pattern?: string; path?: string; limit?: number }
      if (!pattern) return fail("pattern is required")
      try {
        const base = path ? await resolveInWorkspace(workspace, path) : workspace
        const cap = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, 1000))
        const glob = new Bun.Glob(pattern)
        // Collect relative to `base` so the pattern and the returned paths use a
        // single, predictable reference frame. When no base is given, base ===
        // workspace and results are naturally workspace-relative.
        const { files, truncated: walkTruncated } = await collectFiles(base, { limit: 5000 })
        const matches: string[] = []
        for (const f of files) {
          if (matches.length >= cap) break
          const rel = toRel(base, f)
          if (globMatch(pattern, rel, glob)) matches.push(rel)
        }
        return { base, count: matches.length, files: matches, truncated: walkTruncated || matches.length >= cap }
      } catch (e) {
        return fail(message(e))
      }
    },
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

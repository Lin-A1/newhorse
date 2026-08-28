import { readFile } from "node:fs/promises"
import { resolveInWorkspace } from "./path"
import { fail, collectFiles, toRel, isLikelyBinary } from "./common"
import type { Tool } from "@newhorse/core"

const DEFAULT_LIMIT = 100

/**
 * Content search (grep-like) over the workspace: returns file:line:match lines.
 * Capable of matching across files; excludes `.git`/node_modules/binary and caps
 * hits so a real-repo search stays fast, with a `truncated` + `totalMatches`
 * hint so the model knows there is more than it saw.
 */
export function createSearchTool(workspace: string): Tool {
  return {
    name: "search",
    description: `Search workspace file contents for a regex (grep-like). Returns file:line:match. Path under workspace root: ${workspace}`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Base directory to search (relative to workspace root); defaults to workspace root." },
        include: { type: "string", description: 'Optional glob to restrict files, e.g. "**/*.ts".' },
        limit: { type: "number", description: `Max matches to return (default ${DEFAULT_LIMIT}).` },
      },
      required: ["pattern"],
    },
    execute: async (input: unknown) => {
      const { pattern, path, include, limit } = (input ?? {}) as { pattern?: string; path?: string; include?: string; limit?: number }
      if (!pattern) return fail("pattern is required")
      let re: RegExp
      try {
        re = new RegExp(pattern, "i")
      } catch {
        return fail("invalid regular expression")
      }
      try {
        const base = path ? await resolveInWorkspace(workspace, path) : workspace
        const cap = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, 1000))
        const includeGlob = include ? new Bun.Glob(include) : undefined
        const { files } = await collectFiles(base, { limit: 5000 })
        const hits: { file: string; line: number; text: string }[] = []
        let total = 0
        let bytesChecked = 0

        for (const f of files) {
          if (bytesChecked > 8 * 1024 * 1024) break
          const rel = toRel(base, f)
          if (includeGlob && !includeGlob.match(rel)) continue
          if (isLikelyBinary(f)) continue
          let text: string
          try {
            text = await readFile(f, "utf8")
          } catch {
            continue
          }
          bytesChecked += text.length
          const lines = text.split(/\r?\n/)
          // Scan the ENTIRE file so a match deep in a long file is never silently
          // missed (the model would otherwise trust a false "no match"). We cap
          // only the returned `hits`, not the scan range.
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) {
              total += 1
              if (hits.length < cap) {
                hits.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 300) })
              }
            }
          }
        }

        return { pattern, base, totalMatches: total, hits, truncated: total > hits.length }
      } catch (e) {
        return fail(message(e))
      }
    },
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

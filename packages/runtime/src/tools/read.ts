import { readFile } from "node:fs/promises"
import { resolveInWorkspace } from "./path"
import { approve, denied, fail, isLikelyBinary } from "./common"
import { randomUUID } from "node:crypto"
import type { Tool, ToolCtx } from "@newhorse/core"

const DEFAULT_LIMIT = 1000
const LINE_WIDTH_LIMIT = 2000

/**
 * Read a file as text with line numbers. The model needs line numbers so it can
 * reason about "which line to edit" without counting manually — the cheapest
 * self-correction lever (M3.5 §2.4). Results are truncated at a bound to avoid
 * blowing up context; `.git`/node_modules/binary files are excluded upstream.
 */
export function createReadTool(workspace: string): Tool {
  return {
    name: "read",
    description: `Read a text file (with line numbers). Path is relative to or under the workspace root: ${workspace}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file (relative to workspace root or absolute-in-workspace)." },
        offset: { type: "number", description: "1-based line offset to start reading from." },
        limit: { type: "number", description: `Max lines to return (default ${DEFAULT_LIMIT}).` },
      },
      required: ["path"],
    },
    execute: async (input: unknown, ctx?: ToolCtx) => {
      const { path, offset, limit } = (input ?? {}) as { path?: string; offset?: number; limit?: number }
      if (!path) return fail("path is required")
      // M4 execpolicy: reading rules-file boundaries / credentials / protected
      // paths must go through decidePath like every other path-touching tool,
      // not a hardcoded `.newhorse` regex. fail-closed when no policy exists.
      const policy = ctx?.execPolicy
      if (!policy) return denied("denied by execpolicy: no policy available")
      const decision = policy.decidePath(path)
      if (decision === "forbid") return denied(`denied by execpolicy: ${path}`)
      if (decision === "prompt") {
        const ok = await approve(policy, { id: randomUUID(), kind: "path", target: path, decision: "prompt", reason: "path read" })
        if (!ok) return denied(`denied by execpolicy (prompt not approved): ${path}`)
      }
      try {
        const abs = await resolveInWorkspace(workspace, path)
        if (isLikelyBinary(abs)) return fail("refusing to read a binary file")
        const text = await readFile(abs, "utf8")
        const lines = text.split(/\r?\n/)
        const from = Math.max(1, Math.floor(offset ?? 1))
        const count = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT))
        const overlength = count < lines.length
        const out: string[] = []
        const last = Math.min(lines.length, from - 1 + count)
        for (let i = from - 1; i < last; i++) {
          const raw = lines[i]!
          const shown = raw.length > LINE_WIDTH_LIMIT ? raw.slice(0, LINE_WIDTH_LIMIT) + "...[truncated]" : raw
          out.push(`${String(i + 1).padStart(5, " ")} → ${shown}`)
        }
        // A from beyond the file is NOT an error, but a silent empty result
        // confuses the model; say what happened so it can self-correct.
        const offsetBeyond = from > lines.length
        return { path: abs, totalLines: lines.length, lines: out, truncated: overlength, offsetBeyond, offset: from }
      } catch (e) {
        return fail(message(e))
      }
    },
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

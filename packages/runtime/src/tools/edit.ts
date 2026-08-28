import { readFile, writeFile } from "node:fs/promises"
import { resolveInWorkspace } from "./path"
import { fail, isLikelyBinary } from "./common"
import type { Tool } from "@newhorse/core"

/**
 * Exact string replace: the `old` substring is required to match exactly once
 * (unless `replaceAll`). Semantics (M3.5 §1, from the review):
 *   - `old` empty is rejected (empty is contained by any file; fatal with
 *     replaceAll).
 *   - `old === new` is rejected (a no-op would loop the model forever).
 *   - `new` empty is a legal deletion (asymmetric with empty `old`).
 *   - Multi-hit returns a structured payload (hit count + line numbers/context)
 *     so the model can widen `old` to disambiguate, rather than a bare "no".
 *   - EOL is normalized for comparison but the file's original EOL is preserved
 *     on rewrite, so Windows repos (\r\n) are not silently mangled.
 */
export function createEditTool(workspace: string): Tool {
  return {
    name: "edit",
    description: `Exact string replace in a file. Requires "old" to match exactly once (use replaceAll for all occurrences). Path under workspace root: ${workspace}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit (relative to workspace root)." },
        old: { type: "string", description: "The exact existing substring to find (must be unique unless replaceAll)." },
        new: { type: "string", description: "The replacement string. Empty means delete old." },
        replaceAll: { type: "boolean", description: "Replace every occurrence of old (default false)." },
      },
      required: ["path", "old", "new"],
    },
    execute: async (input: unknown) => {
      const { path, old, new: replacement, replaceAll } = (input ?? {}) as { path?: string; old?: string; new?: string; replaceAll?: boolean }
      if (!path) return fail("path is required")
      if (typeof old !== "string" || old.length === 0) return fail("`old` must be a non-empty string")
      if (typeof replacement !== "string") return fail("`new` must be a string")
      if (old === replacement) return fail("`old` and `new` are identical — nothing to change")
      try {
        const abs = await resolveInWorkspace(workspace, path)
        if (isLikelyBinary(abs)) return fail("refusing to edit a binary file")
        const { text, eol } = await readNormalized(abs)
        // Compare on normalized (LF) content; preserve the file's EOL on write.
        const matches = countMatches(text, old)
        if (matches === 0) return fail("`old` not found in file")
        if (matches > 1 && !replaceAll) return disambiguation(abs, text, old, matches)
        const next = replaceAll ? text.split(old).join(replacement) : text.replace(old, replacement)
        await writeFile(abs, eol === "\r\n" ? next.split("\n").join("\r\n") : next, "utf8")
        return { edited: abs, replaced: matches }
      } catch (e) {
        return fail(message(e))
      }
    },
  }
}

/** Read a file, normalizing newlines to LF for comparison; report the file's
 * original EOL so the write can restore it. */
async function readNormalized(abs: string): Promise<{ text: string; eol: "\r\n" | "\n" }> {
  const raw = await readFile(abs, "utf8")
  const eol = raw.includes("\r\n") ? "\r\n" : "\n"
  return { text: raw.split("\r\n").join("\n"), eol }
}

function countMatches(text: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let i = 0
  while (true) {
    const idx = text.indexOf(needle, i)
    if (idx === -1) break
    count += 1
    i = idx + needle.length
  }
  return count
}

/** Return a structured, model-actionable disambiguation payload: hit count plus
 * each line number + short context so the model can widen `old`. */
function disambiguation(abs: string, text: string, old: string, matches: number): Record<string, unknown> {
  const lines = text.split("\n")
  const hits: { line: number; context: string }[] = []
  let from = 0
  while (hits.length < matches) {
    const idx = text.indexOf(old, from)
    if (idx === -1) break
    const lineNo = text.slice(0, idx).split("\n").length
    const context = (lines[lineNo - 1] ?? "").slice(0, 120)
    hits.push({ line: lineNo, context })
    from = idx + old.length
  }
  return {
    error: `\`old\` matched ${matches} times in ${abs} — shown below. Widen \`old\` (or set replaceAll).`,
    matches,
    hits,
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { resolveInWorkspace } from "./path"
import { fail } from "./common"
import type { Tool } from "@newhorse/core"

/**
 * Write a file, creating parent directories inside the workspace. This is an
 * authoritative tool (a sensitive one — it can write a `.ps1`/`.bat` that bash
 * could later execute), so like all tools it is sandboxed to the workspace.
 */
export function createWriteTool(workspace: string): Tool {
  return {
    name: "write",
    description: `Write a file (creates parent dirs). Path is under the workspace root: ${workspace}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write (relative to workspace root)." },
        content: { type: "string", description: "Full file content to write (overwrites existing)." },
      },
      required: ["path", "content"],
    },
    execute: async (input: unknown) => {
      const { path, content } = (input ?? {}) as { path?: string; content?: string }
      if (!path) return fail("path is required")
      if (typeof content !== "string") return fail("content must be a string")
      try {
        const abs = await resolveInWorkspace(workspace, path)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content, "utf8")
        return { written: abs, bytes: content.length }
      } catch (e) {
        return fail(message(e))
      }
    },
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

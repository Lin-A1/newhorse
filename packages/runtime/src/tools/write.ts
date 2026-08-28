import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { resolveInWorkspace } from "./path"
import { approve, denied, fail } from "./common"
import type { Tool, ToolCtx } from "@newhorse/core"

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
    execute: async (input: unknown, ctx?: ToolCtx) => {
      const { path, content } = (input ?? {}) as { path?: string; content?: string }
      if (!path) return fail("path is required")
      if (typeof content !== "string") return fail("content must be a string")
      // M4 execpolicy: gate sensitive paths (e.g. `.newhorse/**`, credentials,
      // executable scripts) via decidePath before touching the filesystem.
      const policy = ctx?.execPolicy
      if (!policy) return denied("denied by execpolicy: no policy available")
      const decision = policy.decidePath(path)
      if (decision === "forbid") return denied(`denied by execpolicy: ${path}`)
      if (decision === "prompt") {
        const ok = await approve(policy, { id: randomUUID(), kind: "path", target: path, decision: "prompt", reason: "path write" })
        if (!ok) return denied(`denied by execpolicy (prompt not approved): ${path}`)
      }
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

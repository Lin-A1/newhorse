import type { Tool } from "@newhorse/core"
import type { MemoryStore } from "@newhorse/memory"
import { createReadTool } from "./read"
import { createWriteTool } from "./write"
import { createEditTool } from "./edit"
import { createListTool } from "./list"
import { createSearchTool } from "./search"
import { createBashTool } from "./bash"
import { createMemorySearchTool, createMemoryWriteTool } from "./memory"

export { createExecPolicy, createBuiltinExecPolicy, rulesFilePath, simpleHash } from "./execpolicy"

/**
 * Build the builtin toolset (M3.5). These are the agent's "hands": read / write
 * / edit / list / search are always available and sandboxed to the workspace;
 * bash is an explicit opt-in because it is not constrained by the fs sandbox
 * (M3.5 §2.2). `enableBash` must be set by the caller (typically via AppConfig)
 * to expose the shell tool.
 *
 * When a `memoryStore` is supplied, the memory tools (memory_search /
 * memory_write) are appended — the seam's consumer side. No store = no memory
 * tools (a clean default; the engine is not memory-captive).
 */
export interface BuiltinToolsOptions {
  readonly workspace: string
  /** Opt-in shell tool; off by default because it escapes the fs sandbox. */
  readonly enableBash?: boolean
  /** Optional memory seam; when present, memory tools are exposed. */
  readonly memoryStore?: MemoryStore
}

export function createBuiltinTools(opts: BuiltinToolsOptions): Tool[] {
  const tools: Tool[] = [
    createReadTool(opts.workspace),
    createWriteTool(opts.workspace),
    createEditTool(opts.workspace),
    createListTool(opts.workspace),
    createSearchTool(opts.workspace),
  ]
  if (opts.enableBash) tools.push(createBashTool(opts.workspace))
  if (opts.memoryStore) {
    tools.push(createMemorySearchTool(opts.memoryStore))
    tools.push(createMemoryWriteTool(opts.memoryStore))
  }
  return tools
}

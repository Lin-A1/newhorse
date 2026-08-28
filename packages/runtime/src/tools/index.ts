import type { Tool } from "@newhorse/core"
import { createReadTool } from "./read"
import { createWriteTool } from "./write"
import { createEditTool } from "./edit"
import { createListTool } from "./list"
import { createSearchTool } from "./search"
import { createBashTool } from "./bash"

export { createExecPolicy, createBuiltinExecPolicy, rulesFilePath } from "./execpolicy"

/**
 * Build the builtin toolset (M3.5). These are the agent's "hands": read / write
 * / edit / list / search are always available and sandboxed to the workspace;
 * bash is an explicit opt-in because it is not constrained by the fs sandbox
 * (M3.5 §2.2). `enableBash` must be set by the caller (typically via AppConfig)
 * to expose the shell tool.
 */
export interface BuiltinToolsOptions {
  readonly workspace: string
  /** Opt-in shell tool; off by default because it escapes the fs sandbox. */
  readonly enableBash?: boolean
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
  return tools
}

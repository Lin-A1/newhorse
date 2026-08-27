import type { Capability, HookEvent } from "./registry"
import { HOOK_EVENTS } from "./registry"

/**
 * Directory-as-registration-surface.
 *
 * A plugin folder is discovered by convention, mirroring Claude Code:
 *   plugin.json      — metadata
 *   tools/           — *.ts or *.json tool definitions
 *   agents/          — *.md agent definitions (frontmatter + body)
 *   commands/        — *.md slash commands
 *   hooks/           — hooks.json event handlers
 *
 * Discovery reads these folders and registers each capability into a
 * PluginRegistry. Targeted at M1: it runs registry wiring only, not a full
 * loader (executing plugin code is a later concern).
 */
export interface DiscoverOptions {
  readonly dir: string
}

export async function discoverPlugin(dir: string): Promise<Capability[]> {
  const caps: Capability[] = []

  const tools = await readDir(dir, "tools")
  for (const file of tools) {
    const cap = await readTool(dir, file)
    if (cap) caps.push(cap)
  }

  const agents = await readDir(dir, "agents")
  for (const file of agents) {
    const cap = await readAgent(dir, file)
    if (cap) caps.push(cap)
  }

  const commands = await readDir(dir, "commands")
  for (const file of commands) {
    const cap = await readCommand(dir, file)
    if (cap) caps.push(cap)
  }

  const hooks = await readHooks(dir)
  for (const hook of hooks) caps.push(hook)

  return caps
}

function baseSlug(name: string): string {
  return name.replace(/\.(md|ts|json)$/, "")
}

async function readTool(dir: string, file: string): Promise<Capability | undefined> {
  if (!file.endsWith(".json")) return undefined
  const def = await readJsonFile(`${dir}/tools/${file}`)
  if (!def || typeof def.name !== "string") return undefined
  const execute = def.execute as undefined // JSON declarations cannot carry a function.
  void execute
  // JSON tool declarations only declare the schema; execution is provided by
  // registered code by name (M1). Mark as a stub that resolves via the registry.
  return { kind: "tool", name: def.name, description: typeof def.description === "string" ? def.description : undefined, execute: async () => { throw new Error(`tool "${def.name}" has no registered implementation`) } }
}

async function readAgent(dir: string, file: string): Promise<Capability | undefined> {
  const text = await readText(dir, "agents", file)
  if (!text) return undefined
  const fm = parseFrontmatter(text)
  const name = fm.name ?? baseSlug(file)
  return { kind: "agent", name, description: fm.description, model: fm.model }
}

async function readCommand(dir: string, file: string): Promise<Capability | undefined> {
  const text = await readText(dir, "commands", file)
  if (!text) return undefined
  const fm = parseFrontmatter(text)
  const name = fm.name ?? baseSlug(file)
  return { kind: "command", name, description: fm.description, run: async () => text }
}

async function readHooks(dir: string): Promise<Capability[]> {
  const hooks: Capability[] = []
  const dirUri = `${dir}/hooks`
  if (!(await exists(dirUri))) return hooks
  const hooksJson = await readJsonFile(`${dirUri}/hooks.json`)
  if (!hooksJson || !Array.isArray(hooksJson.hooks)) return hooks
  for (const h of hooksJson.hooks as { name?: string; event?: string; mode?: "command" | "prompt"; command?: string }[]) {
    if (!h.event || !HOOK_EVENTS.has(h.event)) continue
    hooks.push({
      kind: "hook",
      name: h.name ?? h.event,
      event: h.event as HookEvent,
      mode: h.mode ?? "command",
      run: async () => (h.command ? executeCommand(h.command) : null),
    })
  }
  return hooks
}

async function executeCommand(command: string): Promise<unknown> {
  const proc = Bun.spawn(command.split(" "), { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  return out
}

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {}
  const end = text.indexOf("---", 3)
  if (end === -1) return {}
  const body = text.slice(3, end).trim()
  const out: Record<string, string> = {}
  for (const line of body.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) out[m[1]!] = m[2]!.trim()
  }
  return out
}

async function readDir(base: string, name: string): Promise<string[]> {
  const dir = `${base}/${name}`
  if (!(await exists(dir))) return []
  const fs = await import("node:fs/promises")
  const files = await fs.readdir(dir)
  return files.filter((f) => /\.(md|ts|json)$/.test(f))
}

async function readText(base: string, name: string, file: string): Promise<string | undefined> {
  const path = `${base}/${name}/${file}`
  if (!(await exists(path))) return undefined
  return Bun.file(path).text()
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  if (!(await exists(path))) return undefined
  try {
    return await Bun.file(path).json()
  } catch {
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  const fs = await import("node:fs/promises")
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

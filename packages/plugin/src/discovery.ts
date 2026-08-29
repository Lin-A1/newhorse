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
 *   skills/          — *.md skill definitions (metadata → SKILL.md disclosure)
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

/**
 * Three-level skill disclosure (AGENTS.md): metadata → SKILL.md →
 * references/scripts. Discovery reads the two discoverable levels of a skill
 * file and exposes them as model-visible content, not as a Capability (a skill
 * is context, not an executable hook).
 *
 * Level 1 (metadata) is the frontmatter name/description — the trigger surface.
 * Level 2 (SKILL.md) is the full instruction body the model reads when the
 * skill matches. Level 3 (references/scripts) is requested on demand by the
 * skill body, not eagerly loaded.
 *
 * A skill folder is convention-shaped:
 *   skills/<name>/SKILL.md        — level 2 (body)
 *   skills/<name>.md              — flat single-file skill (alternative shape)
 *   skills/<name>/references/     — level 3 (on-demand, not loaded here)
 *   skills/<name>/scripts/        — level 3 (on-demand, not loaded here)
 */
export interface SkillDisclosure {
  readonly name: string
  readonly description?: string
  /** Level 2: the skill instruction body — full SKILL.md (folder) or the whole
   * flat `<name>.md` file. Always present; a skill with no readable body is not
   * returned. */
  readonly body: string
  readonly path: string
}

/** Discover skills by convention under a plugin dir. */
export async function discoverSkills(dir: string): Promise<SkillDisclosure[]> {
  const skillsDir = `${dir}/skills`
  if (!(await exists(skillsDir))) return []
  const fs = await import("node:fs/promises")
  let names: string[] = []
  try {
    names = (await fs.readdir(skillsDir)).sort()
  } catch {
    return []
  }
  const out: SkillDisclosure[] = []
  for (const name of names) {
    // skills/<name>/SKILL.md (folder) or skills/<name>.md (flat).
    const folder = `${skillsDir}/${name}`
    if (await exists(`${folder}/SKILL.md`)) {
      const body = await readTextFile(`${folder}/SKILL.md`)
      if (body) out.push({ name, description: parseFrontmatter(body).description, body, path: `${folder}/SKILL.md` })
      continue
    }
    if (name.endsWith(".md")) {
      const base = name.slice(0, -3)
      const body = await readTextFile(`${skillsDir}/${name}`)
      if (body) out.push({ name: base, description: parseFrontmatter(body).description, body, path: `${skillsDir}/${name}` })
    }
  }
  return out
}

function baseSlug(name: string): string {
  return name.replace(/\.(md|ts|json)$/, "")
}

/**
 * Read a single tool definition file.
 *
 * JSON tool declarations only declare the schema; execution is provided by
 * registered code by name (M1) — a JSON tool is a declared-but-unimplemented
 * stub that fails loudly at execution rather than silently no-oping.
 *
 * A `.ts` tool definition exports a `Tool` (or a function returning one) via
 * `export const tool` / `export function tool()`. Loading plugin TS code is a
 * later concern; until then a `.ts` declaration is skipped the same way a
 * non-JSON file is, so discovery never registers a tool it cannot execute.
 */
async function readTool(dir: string, file: string): Promise<Capability | undefined> {
  if (!file.endsWith(".json")) return undefined
  const def = await readJsonFile(`${dir}/tools/${file}`)
  if (!def || typeof def.name !== "string") return undefined
  return { kind: "tool", name: def.name, description: typeof def.description === "string" ? def.description : undefined, execute: async () => { throw new Error(`tool "${def.name}" has no registered implementation`) } }
}

async function readAgent(dir: string, file: string): Promise<Capability | undefined> {
  const text = await readText(dir, "agents", file)
  if (!text) return undefined
  const fm = parseFrontmatter(text)
  const name = fm.name ?? baseSlug(file)
  // Body = the markdown after the frontmatter. When the file has no frontmatter
  // (doesn't start with "---"), the whole text is the body.
  let body: string | undefined
  if (text.startsWith("---")) {
    const end = text.indexOf("---", 3)
    body = end >= 0 ? text.slice(end + 3).trim() : undefined
  } else {
    body = text.trim()
  }
  const allowedTools = fm["allowed-tools"]?.split(",").map((s) => s.trim()).filter(Boolean)
  return { kind: "agent", name, description: fm.description, body: body || undefined, allowedTools: allowedTools?.length ? allowedTools : undefined, role: fm.role, model: fm.model }
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

/**
 * Execute a hook command line through a shell-aware argv split.
 *
 * A naive `command.split(" ")` breaks any hook whose command carries a quoted
 * argument (`rg 'foo bar'`, `echo "a b"`). We tokenize like a shell: a quoted
 * section is one arg, adjacent quotes concatenate, and backslash escapes the
 * next character in double quotes. Unparsable CLI is a documentation/health
 * issue for the hook author, not a security boundary — this only needs to be
 * good enough to not corrupt the command.
 */
async function executeCommand(command: string): Promise<unknown> {
  const argv = shellSplit(command)
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd: process.cwd() })
  const out = await new Response(proc.stdout).text()
  return out
}

/** Shell-word tokenizer for hook commands. Splits on unquoted whitespace,
 * removes quote chars (single quotes literal; double quotes process `\"` and
 * `\\`), and keeps a quoted section with no preceding whitespace attached to
 * the current token (so `--flag="a b"` is one arg: `--flag=a b`). */
export function shellSplit(cmd: string): string[] {
  const out: string[] = []
  let cur = ""
  let inSingle = false
  let inDouble = false
  let tokenStarted = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (inSingle) {
      if (ch === "'") inSingle = false
      else cur += ch
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else if (ch === "\\") {
        // Only `\"` and `\\` are escapes inside double quotes.
        const next = cmd[i + 1]
        if (next === '"' || next === "\\") { cur += next; i++ } else cur += ch
      } else cur += ch
      continue
    }
    if (ch === "'") { inSingle = true; tokenStarted = true; continue }
    if (ch === '"') { inDouble = true; tokenStarted = true; continue }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (tokenStarted) { out.push(cur); cur = ""; tokenStarted = false }
      continue
    }
    cur += ch
    tokenStarted = true
  }
  if (tokenStarted) out.push(cur)
  return out
}

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {}
  const end = text.indexOf("---", 3)
  if (end === -1) return {}
  const body = text.slice(3, end).trim()
  const out: Record<string, string> = {}
  for (const line of body.split("\n")) {
    // Keys may include hyphens (e.g. allowed-tools), so match [\w-]+ not \w+.
    const m = line.match(/^([\w-]+):\s*(.*)$/)
    if (m) out[m[1]!] = m[2]!.trim()
  }
  return out
}

async function readDir(base: string, name: string): Promise<string[]> {
  const dir = `${base}/${name}`
  if (!(await exists(dir))) return []
  const fs = await import("node:fs/promises")
  const files = await fs.readdir(dir)
  // Sort so the convention-based discovery order is deterministic regardless of
  // platform. fs.readdir order is unspecified by Node; plugin tools that collide
  // by name resolve first-wins downstream, so the discovery order must be stable.
  return files.filter((f) => /\.(md|ts|json)$/.test(f)).sort()
}

async function readText(base: string, name: string, file: string): Promise<string | undefined> {
  const path = `${base}/${name}/${file}`
  if (!(await exists(path))) return undefined
  return Bun.file(path).text()
}

/** Read a bare path (already fully formed) as text, or undefined. */
async function readTextFile(path: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined
  try {
    return await Bun.file(path).text()
  } catch {
    return undefined
  }
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

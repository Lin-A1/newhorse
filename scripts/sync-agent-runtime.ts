/**
 * Sync the runtime engine from the newhorse monorepo to the standalone
 * agent-runtime repository (github.com/Lin-A1/agent-runtime).
 *
 * Usage:  bun run scripts/sync-agent-runtime.ts [--check]
 *   --check : verify no drift (exit 1 if any synced file differs), copy nothing.
 *
 * INCLUDE (engine + QA + engine docs) — these MUST match upstream:
 *   packages/{schema,core,llm,plugin,memory,runtime,server,sdk}  (full dirs)
 *   package.json / tsconfig.json / bun.lock / .gitignore          (workspace)
 *   specs/v2/ + docs/{core-technology-notes,architecture-map}.md  (design record)
 *   scripts/smoke/                                               (engine QA)
 *
 * EXCLUDE (each repo owns its own identity/host content — NEVER synced):
 *   README.md, AGENTS.md, handoff.md, packages/cli (host shell).
 *   The standalone repo's README/AGENTS describe the runtime from the
 *   CONSUMER's perspective and are maintained there.
 *
 * Safety: sync is OVERWRITE-ONLY (never rm-then-copy) — a failed copy can
 * never delete files that exist only in the destination (agent-runtime's
 * node_modules, local docs, etc.). Line endings normalize to LF on both
 * compare and write (Windows git autocrlf checks out CRLF).
 */
import { cp, readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"

const UPSTREAM = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const DEST = process.env.AGENT_RUNTIME_REPO ?? "G:/Code/Agents/Custom/agent-runtime"
const CHECK = process.argv.includes("--check")

const PACKAGES = ["schema", "core", "llm", "plugin", "memory", "runtime", "server", "sdk"]
const ROOT_FILES = ["package.json", "tsconfig.json", "bun.lock", ".gitignore"]
const DOC_FILES = ["docs/core-technology-notes.md", "docs/architecture-map.md"]

let copied = 0
const drifted: string[] = []

const LF = (b: Buffer): string => b.toString("utf8").split("\r\n").join("\n")

/** Compare one file (LF-normalized); records drift in check mode. */
async function checkFile(src: string, dst: string): Promise<void> {
  const a = LF(await readFile(src))
  const b = await readFile(dst).then((x) => LF(x), () => null)
  if (b === null || a !== b) drifted.push(dst)
}

/** Copy one file (LF-normalized, mkdir parents). */
async function copyFile(src: string, dst: string): Promise<void> {
  const a = LF(await readFile(src))
  await mkdir(dirname(dst), { recursive: true })
  await writeFile(dst, a, "utf8")
  copied++
}

/** Recursively list source files (skips node_modules / symlinks / tsbuildinfo). */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name.endsWith(".tsbuildinfo")) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(p)))
    else out.push(p)
  }
  return out
}

// --- engine packages: overwrite-sync (never rm-then-copy) ---
for (const pkg of PACKAGES) {
  const src = join(UPSTREAM, "packages", pkg)
  const dst = join(DEST, "packages", pkg)
  if (CHECK) {
    for (const f of await listFiles(src)) {
      const rel = f.slice(src.length)
      await checkFile(f, join(dst, rel))
    }
  } else {
    await cp(src, dst, { recursive: true, force: true, filter: (s) => !s.includes("node_modules") })
  }
}
// --- workspace config ---
for (const f of ROOT_FILES) {
  if (CHECK) await checkFile(join(UPSTREAM, f), join(DEST, f))
  else await copyFile(join(UPSTREAM, f), join(DEST, f))
}
// --- engine design record + QA ---
for (const f of DOC_FILES) {
  if (CHECK) await checkFile(join(UPSTREAM, f), join(DEST, f))
  else await copyFile(join(UPSTREAM, f), join(DEST, f))
}
if (CHECK) {
  const smokeBase = join(UPSTREAM, "scripts", "smoke")
  for (const f of await listFiles(smokeBase)) await checkFile(f, join(DEST, "scripts", "smoke", f.slice(smokeBase.length + 1)))
  const specsBase = join(UPSTREAM, "specs", "v2")
  for (const f of await listFiles(specsBase)) await checkFile(f, join(DEST, "specs", "v2", f.slice(specsBase.length + 1)))
} else {
  await cp(join(UPSTREAM, "scripts", "smoke"), join(DEST, "scripts", "smoke"), { recursive: true, force: true })
  await cp(join(UPSTREAM, "specs", "v2"), join(DEST, "specs", "v2"), { recursive: true, force: true })
}

if (CHECK) {
  if (drifted.length > 0) {
    console.error(`DRIFT detected (${drifted.length} files differ from upstream):`)
    for (const d of drifted) console.error("  " + d)
    process.exit(1)
  }
  console.log("CHECK OK: agent-runtime engine trees match upstream.")
} else {
  console.log(`synced (${copied} files written) → ${DEST}`)
}

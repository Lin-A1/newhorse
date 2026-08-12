import path from "path"
import fs from "fs"
import os from "os"
import { createRequire } from "module"
import { buffer } from "node:stream/consumers"
import { Schema, Effect } from "effect"
import { Global } from "@newhorse/core/global"
import { which } from "@newhorse/core/util/which"
import { InstanceState } from "@/effect/instance-state"
import * as Process from "../util/process"
import * as Tool from "./tool"

/**
 * AST-aware structural search / replace tools backed by the ast-grep CLI
 * (`sg`). The CLI is spawned as an external process and fed a pattern plus a
 * language; it returns matches as `--json=compact`.
 *
 * Binary resolution order:
 *   1. `AST_GREP_BIN` (absolute path to the binary) or `AST_GREP_CLI_PATH`
 *      (directory containing the binary) env vars.
 *   2. `sg` / `sg.exe` found on PATH (includes the app cache bin dir).
 *   3. The cached binary in the app bin directory (`Global.Path.bin`).
 *   4. The `@ast-grep/cli` npm package (platform package `@ast-grep/cli-*`),
 *      when installed.
 *   5. On spawn ENOENT, a best-effort download of the platform npm package
 *      tarball (`@ast-grep/cli-<platform>/-/cli-<platform>-<version>.tgz`) is
 *      attempted and the command is retried once.
 *
 * Registration is intentionally left to the caller: add both tools to
 * `packages/opencode/src/tool/registry.ts` (TODO below) — this file only
 * defines and exports them.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ast-grep CLI supported languages (25). */
export const CLI_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "elixir",
  "go",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "swift",
  "typescript",
  "tsx",
  "yaml",
] as const

export type CliLanguage = (typeof CLI_LANGUAGES)[number]

export const AST_GREP_SEARCH_ID = "ast_grep_search"
export const AST_GREP_REPLACE_ID = "ast_grep_replace"

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024
const DEFAULT_MAX_MATCHES = 500
/** Fallback version used for the npm tarball download when `@ast-grep/cli` is not installed. */
const DEFAULT_VERSION = "0.45.1"

const BINARY_NAME = process.platform === "win32" ? "sg.exe" : "sg"
const NATIVE_BINARY_NAMES = process.platform === "win32" ? ["ast-grep.exe", "sg.exe"] : ["ast-grep", "sg"]

/**
 * npm optional-dependency suffixes per platform (matches `@ast-grep/cli`).
 * The full package name is `@ast-grep/cli-<suffix>`.
 */
const PLATFORM_SUFFIX: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64": "linux-x64-gnu",
  "win32-arm64": "win32-arm64-msvc",
  "win32-ia32": "win32-ia32-msvc",
  "win32-x64": "win32-x64-msvc",
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliPosition {
  line: number
  column: number
}

/** One match object from `sg run --json=compact`. */
export interface CliMatch {
  text: string
  file: string
  lines: string
  range: { start: CliPosition; end: CliPosition }
  language?: string
}

export interface SgResult {
  matches: CliMatch[]
  totalMatches: number
  truncated: boolean
  truncatedReason?: "max_matches" | "max_output_bytes" | "timeout"
  error?: string
}

export interface RunOptions {
  pattern: string
  lang: CliLanguage
  paths?: readonly string[]
  globs?: readonly string[]
  rewrite?: string
  context?: number
  /** Apply rewrites to files instead of previewing them. */
  updateAll?: boolean
  /** Working directory for the `sg` process. Defaults to the parent process cwd. */
  cwd?: string
}

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

export interface SpawnInput {
  cmd: string[]
  cwd?: string
  timeoutMs: number
}

export type SpawnFn = (input: SpawnInput) => Promise<SpawnResult>

export interface Runner {
  spawn: SpawnFn
  resolveBinary(input: { download: boolean }): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Argument building / result parsing (pure, unit-testable)
// ---------------------------------------------------------------------------

export function buildSgArgs(options: RunOptions): string[] {
  const args = ["run", "-p", options.pattern, "--lang", options.lang, "--json=compact"]
  if (options.rewrite) {
    args.push("-r", options.rewrite)
    if (options.updateAll) args.push("--update-all")
  }
  if (options.context && options.context > 0) args.push("-C", String(options.context))
  if (options.globs && options.globs.length > 0) {
    for (const glob of options.globs) args.push("--globs", glob)
  }
  const paths = options.paths && options.paths.length > 0 ? options.paths : ["."]
  args.push(...paths)
  return args
}

/**
 * Parse `sg run --json=compact` output into match objects. The CLI emits a
 * compact JSON array, but some versions emit JSON Lines (one object per line),
 * so both formats are accepted. Returns null when nothing could be parsed.
 */
function parseSgMatches(text: string): CliMatch[] | null {
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed as CliMatch[]
  } catch {
    // not a single JSON array — fall through to JSON Lines
  }
  const lines: CliMatch[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      lines.push(JSON.parse(trimmed) as CliMatch)
    } catch {
      break // last line may be truncated mid-object
    }
  }
  return lines.length > 0 ? lines : null
}

/**
 * Index of the last complete top-level JSON object in a truncated document
 * (or -1). Tracks string/escape state and brace depth so the `},` separators
 * nested inside match objects (e.g. `range`) are not mistaken for match
 * boundaries.
 */
function lastTopLevelObjectEnd(text: string): number {
  let inString = false
  let escape = false
  let bracketDepth = 0
  let braceDepth = 0
  let lastEnd = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "[") {
      bracketDepth++
      continue
    }
    if (ch === "{") {
      braceDepth++
      continue
    }
    if (ch === "]") {
      bracketDepth--
      continue
    }
    if (ch === "}") {
      braceDepth--
      if (braceDepth === 0 && bracketDepth === 1) lastEnd = i
    }
  }
  return lastEnd
}

export function parseSgResult(result: SpawnResult): SgResult {
  if (result.code !== 0 && result.stdout.trim() === "") {
    if (/no files found/i.test(result.stderr)) return { matches: [], totalMatches: 0, truncated: false }
    if (result.stderr.trim()) return { matches: [], totalMatches: 0, truncated: false, error: result.stderr.trim() }
    return { matches: [], totalMatches: 0, truncated: false }
  }
  if (!result.stdout.trim()) return { matches: [], totalMatches: 0, truncated: false }

  const outputTruncated = result.stdout.length >= DEFAULT_MAX_OUTPUT_BYTES
  const text = outputTruncated ? result.stdout.slice(0, DEFAULT_MAX_OUTPUT_BYTES) : result.stdout

  let matches: CliMatch[] | null = parseSgMatches(text)
  if (outputTruncated && (!matches || matches.length === 0)) {
    // Truncated JSON array: keep every complete top-level match.
    const end = lastTopLevelObjectEnd(text)
    if (end > 1) {
      try {
        matches = JSON.parse(text.slice(0, end + 1) + "]") as CliMatch[]
      } catch {
        matches = null
      }
    }
  }

  if (!matches || matches.length === 0) {
    if (outputTruncated) {
      return {
        matches: [],
        totalMatches: 0,
        truncated: true,
        truncatedReason: "max_output_bytes",
        error: "Output too large and could not be parsed",
      }
    }
    return { matches: [], totalMatches: 0, truncated: false }
  }

  const total = matches.length
  const overLimit = total > DEFAULT_MAX_MATCHES
  const final = overLimit ? matches.slice(0, DEFAULT_MAX_MATCHES) : matches
  return {
    matches: final,
    totalMatches: total,
    truncated: outputTruncated || overLimit,
    truncatedReason: outputTruncated ? "max_output_bytes" : overLimit ? "max_matches" : undefined,
  }
}

const MAX_SNIPPET = 300

function snippet(text: string): string {
  const one = text.replace(/\r?\n/g, " ⏎ ").trim()
  return one.length > MAX_SNIPPET ? one.slice(0, MAX_SNIPPET) + "…" : one
}

function truncationNote(result: SgResult): string {
  switch (result.truncatedReason) {
    case "max_matches":
      return `showing first ${result.matches.length} of ${result.totalMatches} matches`
    case "max_output_bytes":
      return "output exceeded 1MB limit"
    case "timeout":
      return "search timed out"
    default:
      return "output truncated"
  }
}

function location(match: CliMatch): string {
  return `${match.file}:${match.range.start.line + 1}:${match.range.start.column + 1}`
}

export function formatSearchResult(result: SgResult): string {
  if (result.error) return `Error: ${result.error}`
  if (result.matches.length === 0) return "No matches found"
  const lines: string[] = []
  if (result.truncated) {
    lines.push(`[TRUNCATED] Results truncated (${truncationNote(result)})`)
    lines.push("")
  }
  lines.push(`Found ${result.totalMatches} match(es)${result.truncated ? ` (showing first ${result.matches.length})` : ""}`)
  lines.push("")
  for (const match of result.matches) {
    lines.push(location(match))
    lines.push(`  ${snippet(match.lines)}`)
    lines.push("")
  }
  return lines.join("\n")
}

export function formatReplaceResult(result: SgResult, dryRun: boolean): string {
  if (result.error) return `Error: ${result.error}`
  if (result.matches.length === 0) return "No matches found to replace"
  const prefix = dryRun ? "[DRY RUN] " : ""
  const lines: string[] = []
  if (result.truncated) {
    lines.push(`[TRUNCATED] Results truncated (${truncationNote(result)})`)
    lines.push("")
  }
  lines.push(
    `${prefix}${result.totalMatches} replacement(s)${result.truncated ? ` (showing first ${result.matches.length})` : ""}`,
  )
  lines.push("")
  for (const match of result.matches) {
    lines.push(location(match))
    lines.push(`  ${snippet(match.text)}`)
    lines.push("")
  }
  if (dryRun) lines.push("Use dryRun=false to apply changes")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

export class AstGrepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ast-grep command timed out after ${timeoutMs}ms`)
    this.name = "AstGrepTimeoutError"
  }
}

function realSpawn(input: SpawnInput): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const proc = Process.spawn(input.cmd, { cwd: input.cwd, stdout: "pipe", stderr: "pipe" })
    if (!proc.stdout || !proc.stderr) {
      reject(new Error("ast-grep process output streams unavailable"))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void Process.stop(proc).catch(() => {})
      reject(new AstGrepTimeoutError(input.timeoutMs))
    }, input.timeoutMs)
    Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
      .then(([code, stdout, stderr]) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() })
      })
      .catch((error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
  })
}

function isENOENT(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    if ((error as { code?: unknown }).code === "ENOENT") return true
  }
  const msg = error instanceof Error ? error.message : String(error)
  return /ENOENT/i.test(msg) || /not found/i.test(msg)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function notFoundResult(): SgResult {
  return {
    matches: [],
    totalMatches: 0,
    truncated: false,
    error:
      "ast-grep CLI binary not found and could not be downloaded.\n\n" +
      "Install manually with one of:\n" +
      "  bun add -D @ast-grep/cli\n" +
      "  cargo install ast-grep --locked\n" +
      "  brew install ast-grep\n" +
      "Or point the AST_GREP_BIN environment variable at the sg binary.",
  }
}

function classifySpawnError(error: unknown): SgResult {
  if (error instanceof AstGrepTimeoutError) {
    return { matches: [], totalMatches: 0, truncated: true, truncatedReason: "timeout", error: error.message }
  }
  return { matches: [], totalMatches: 0, truncated: false, error: `Failed to spawn ast-grep: ${message(error)}` }
}

// Test seam: inject a fake runner so the tools can be unit-tested without a
// real `sg` binary. Production code never sets this. Reset with null.
let runnerOverride: Partial<Runner> | undefined

export function setAstGrepRunnerForTest(runner: Partial<Runner> | null): void {
  runnerOverride = runner ?? undefined
}

export async function runSg(options: RunOptions, runner?: Partial<Runner>): Promise<SgResult> {
  const spawn = runner?.spawn ?? runnerOverride?.spawn ?? realSpawn
  const resolveBinary = runner?.resolveBinary ?? runnerOverride?.resolveBinary ?? defaultResolveBinary
  const args = buildSgArgs(options)
  const attempt = (bin: string) => spawn({ cmd: [bin, ...args], cwd: options.cwd, timeoutMs: DEFAULT_TIMEOUT_MS })

  const binary = (await resolveBinary({ download: false })) ?? "sg"
  try {
    return parseSgResult(await attempt(binary))
  } catch (error) {
    if (isENOENT(error)) {
      const downloaded = await resolveBinary({ download: true })
      if (downloaded && downloaded !== binary) {
        try {
          return parseSgResult(await attempt(downloaded))
        } catch (retryError) {
          if (isENOENT(retryError)) return notFoundResult()
          return classifySpawnError(retryError)
        }
      }
      return notFoundResult()
    }
    return classifySpawnError(error)
  }
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function isValidBinary(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 10_000
  } catch {
    return false
  }
}

export function findSgBinary(): string | null {
  for (const key of ["AST_GREP_BIN", "AST_GREP_CLI_PATH"] as const) {
    const raw = process.env[key]
    if (!raw) continue
    const candidate = key === "AST_GREP_CLI_PATH" ? path.join(raw, BINARY_NAME) : raw
    if (isValidBinary(candidate)) return candidate
  }

  const onPath = which(BINARY_NAME)
  if (onPath && isValidBinary(onPath)) return onPath

  const cached = path.join(Global.Path.bin, BINARY_NAME)
  if (isValidBinary(cached)) return cached

  return resolveFromNodeModules()
}

function resolveFromNodeModules(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const suffix = PLATFORM_SUFFIX[`${process.platform}-${process.arch}`]
    if (suffix) {
      const pkgPath = require.resolve(`@ast-grep/cli-${suffix}/package.json`)
      for (const name of NATIVE_BINARY_NAMES) {
        const candidate = path.join(path.dirname(pkgPath), name)
        if (isValidBinary(candidate)) return candidate
      }
    }
  } catch {
    // platform package not installed
  }
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve("@ast-grep/cli/package.json")
    for (const name of NATIVE_BINARY_NAMES) {
      const candidate = path.join(path.dirname(pkgPath), name)
      if (isValidBinary(candidate)) return candidate
    }
  } catch {
    // @ast-grep/cli not installed
  }
  return null
}

function getAstGrepVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require("@ast-grep/cli/package.json") as { version?: unknown } | undefined
    if (typeof pkg?.version === "string") return pkg.version
  } catch {
    // not installed — use the pinned default
  }
  return DEFAULT_VERSION
}

function findExecutableInDir(dir: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isFile() && NATIVE_BINARY_NAMES.includes(entry.name) && isValidBinary(path.join(dir, entry.name))) {
      return path.join(dir, entry.name)
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findExecutableInDir(path.join(dir, entry.name))
      if (found) return found
    }
  }
  return null
}

let downloadPromise: Promise<string | null> | null = null

export function downloadAstGrepBinary(): Promise<string | null> {
  if (downloadPromise) return downloadPromise
  downloadPromise = doDownload()
    .catch((error: unknown) => {
      console.error(`[ast-grep] failed to download binary: ${message(error)}`)
      return null
    })
    .finally(() => {
      downloadPromise = null
    })
  return downloadPromise
}

async function doDownload(): Promise<string | null> {
  const target = path.join(Global.Path.bin, BINARY_NAME)
  if (isValidBinary(target)) return target

  const suffix = PLATFORM_SUFFIX[`${process.platform}-${process.arch}`]
  if (!suffix) {
    console.error(`[ast-grep] unsupported platform: ${process.platform}-${process.arch}`)
    return null
  }

  const version = getAstGrepVersion()
  const url = `https://registry.npmjs.org/@ast-grep/cli-${suffix}/-/cli-${suffix}-${version}.tgz`

  fs.mkdirSync(Global.Path.bin, { recursive: true })
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error(`empty download from ${url}`)

  const dir = fs.mkdtempSync(path.join(Global.Path.bin, "ast-grep-"))
  try {
    const archive = path.join(dir, "package.tgz")
    fs.writeFileSync(archive, bytes)
    // `tar` (bsdtar) ships with Windows 10+ / macOS / Linux.
    const extracted = await Process.run(["tar", "-xzf", archive, "-C", dir], { nothrow: true })
    if (extracted.code !== 0) {
      throw new Error(`tar extraction failed: ${extracted.stderr.toString().trim() || `exit ${extracted.code}`}`)
    }
    const binary = findExecutableInDir(dir)
    if (!binary) throw new Error("archive did not contain the sg executable")
    fs.copyFileSync(binary, target)
    if (process.platform !== "win32") fs.chmodSync(target, 0o755)
    if (!isValidBinary(target)) throw new Error("downloaded binary looks invalid")
    return target
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

let cachedBinaryPath: string | null = null

async function defaultResolveBinary(input: { download: boolean }): Promise<string | null> {
  if (cachedBinaryPath && isValidBinary(cachedBinaryPath)) return cachedBinaryPath
  const found = findSgBinary()
  if (found) {
    cachedBinaryPath = found
    return found
  }
  if (!input.download) return null
  const downloaded = await downloadAstGrepBinary()
  if (downloaded) cachedBinaryPath = downloaded
  return downloaded
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// Note: `Schema.Literals` (array form) — `Schema.Literal(...spread)` in this
// effect version mis-compiles a large literal list and only accepts the first
// element, so pass the whole array instead.
const Lang = Schema.Literals(CLI_LANGUAGES)

const SEARCH_DESCRIPTION = `Search code with AST-aware pattern matching (ast-grep / sg).

Unlike plain-text grep, the pattern must be valid code for the target language —
ast-grep matches complete AST nodes. Use meta-variables to capture parts of a match:
  $VAR   captures a single node (identifier, expression, statement, ...)
  $$$    captures zero or more nodes (function params, statements, ...)

The pattern must be a complete AST node. For functions include the params and body:
  'async function $NAME($$$) { $$$ }'   (not 'async function $NAME')

Examples:
  console.log($MSG)                    -> all console.log calls
  def $FUNC($$$):                      -> all Python function definitions
  import { $A } from "$MOD"            -> named imports

Output is one "file:line:col" line plus the matched source line per match.
Truncated at 500 matches or 1MB of output.`

const REPLACE_DESCRIPTION = `Replace code matching an AST pattern with a rewrite (ast-grep / sg).

The rewrite may reference meta-variables captured by the pattern:
  pattern:  console.log($MSG)
  rewrite:  logger.info($MSG)

This tool is DRY-RUN by default: it previews the replacements and does NOT modify
files. Set dryRun=false to apply the replacements in place.

The sg binary is resolved from PATH, the AST_GREP_BIN / AST_GREP_CLI_PATH env
vars, node_modules (@ast-grep/cli), or is auto-downloaded on first use.`

const SearchParameters = Schema.Struct({
  pattern: Schema.String.annotate({
    description:
      "AST pattern with meta-variables: $VAR captures a single node, $$$ captures zero or more nodes. Must be a complete AST node for the target language.",
  }),
  lang: Lang.annotate({ description: "Target language" }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Paths to search (default: ['.'])",
  }),
  globs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Include/exclude globs (prefix ! to exclude)",
  }),
  context: Schema.optional(Schema.Number).annotate({
    description: "Number of context lines to show around each match",
  }),
})
type SearchParams = Schema.Schema.Type<typeof SearchParameters>

type AstGrepMetadata = { matches: number; sgTruncated?: boolean }

export const AstGrepSearchTool = Tool.define<typeof SearchParameters, AstGrepMetadata, never>(
  AST_GREP_SEARCH_ID,
  Effect.succeed({
    description: SEARCH_DESCRIPTION,
    parameters: SearchParameters,
    execute: (params: SearchParams, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        yield* ctx.ask({
          permission: AST_GREP_SEARCH_ID,
          patterns: [params.pattern],
          always: ["*"],
          metadata: {
            pattern: params.pattern,
            lang: params.lang,
            paths: params.paths ?? [],
            globs: params.globs ?? [],
          },
        })
        const result = yield* Effect.promise(() =>
          runSg({
            pattern: params.pattern,
            lang: params.lang,
            paths: params.paths,
            globs: params.globs,
            context: params.context,
            cwd: instance.directory,
          }),
        )
        const metadata: AstGrepMetadata = {
          matches: result.totalMatches,
          ...(result.truncated ? { sgTruncated: true } : {}),
        }
        return {
          title: `ast-grep: ${params.pattern}`,
          metadata,
          output: formatSearchResult(result),
        }
      }).pipe(Effect.orDie),
  }),
)

const ReplaceParameters = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "AST pattern to match (may use $VAR / $$$ meta-variables)",
  }),
  rewrite: Schema.String.annotate({
    description: "Replacement pattern (may reference $VAR meta-variables from the pattern)",
  }),
  lang: Lang.annotate({ description: "Target language" }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Paths to search (default: ['.'])",
  }),
  globs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Include/exclude globs (prefix ! to exclude)",
  }),
  dryRun: Schema.optional(Schema.Boolean).annotate({
    description: "Preview changes without applying them (default: true)",
  }),
})
type ReplaceParams = Schema.Schema.Type<typeof ReplaceParameters>

export const AstGrepReplaceTool = Tool.define<typeof ReplaceParameters, AstGrepMetadata, never>(
  AST_GREP_REPLACE_ID,
  Effect.succeed({
    description: REPLACE_DESCRIPTION,
    parameters: ReplaceParameters,
    execute: (params: ReplaceParams, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const dryRun = params.dryRun !== false
        yield* ctx.ask({
          permission: AST_GREP_REPLACE_ID,
          patterns: [params.pattern],
          always: [],
          metadata: {
            pattern: params.pattern,
            rewrite: params.rewrite,
            lang: params.lang,
            paths: params.paths ?? [],
            globs: params.globs ?? [],
            dryRun,
          },
        })
        const result = yield* Effect.promise(() =>
          runSg({
            pattern: params.pattern,
            rewrite: params.rewrite,
            lang: params.lang,
            paths: params.paths,
            globs: params.globs,
            updateAll: !dryRun,
            cwd: instance.directory,
          }),
        )
        const metadata: AstGrepMetadata = {
          matches: result.totalMatches,
          ...(result.truncated ? { sgTruncated: true } : {}),
        }
        return {
          title: `ast-grep replace: ${params.pattern} -> ${params.rewrite}`,
          metadata,
          output: formatReplaceResult(result, dryRun),
        }
      }).pipe(Effect.orDie),
  }),
)

/**
 * TODO(ast-grep): register both tools in `packages/opencode/src/tool/registry.ts`:
 *
 *   import { AstGrepSearchTool, AstGrepReplaceTool } from "./ast-grep"
 *
 *   // inside the registry layer:
 *   const astGrepSearch = yield* AstGrepSearchTool
 *   const astGrepReplace = yield* AstGrepReplaceTool
 *   // ...add both to the `tool` object and the `builtin` array in
 *   // `ToolRegistry.state`.
 */

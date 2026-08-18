/**
 * Browser automation tools for newhorse, powered by the native `agent-browser`
 * CLI (vercel-labs/agent-browser, Apache-2.0).
 *
 * agent-browser is a Rust binary that drives Chrome/Chromium over CDP and
 * exposes a compact command surface (`open`, `snapshot`, `click`, `type`,
 * `eval`, `screenshot`, `session`, ...). These tools spawn that binary once
 * per call with `--json`, parse the single JSON response line, and return it
 * to the model.
 *
 * ## Binary resolution
 *
 * Mirrors `packages/core/src/ripgrep/binary.ts`:
 *
 *   1. `AGENT_BROWSER_PATH` env var (explicit path to the executable)
 *   2. `agent-browser` on `PATH`
 *   3. cached copy in `Global.Path.bin` (downloaded by a future vendor step)
 *
 * If none is found the tool errors with install instructions.
 *
 * ## Security
 *
 * Every tool calls `ctx.ask({ permission: "browser", ... })` before spawning
 * anything. `browser` has no default allow rule, so the first call (and any
 * call the user has not pre-approved) is gated behind the permission prompt —
 * browser automation is never silently executed. `browser_eval` additionally
 * executes arbitrary JavaScript in the page and is described as such.
 *
 * Free-form parameters are validated against CLI-flag injection (values that
 * start with `-` are rejected where the CLI would misparse them) and NUL/control
 * characters, and each value is length-capped.
 *
 * Each opencode session gets a dedicated agent-browser session
 * (`nh-<sanitized session id>`) so concurrent conversations do not share
 * browser state.
 *
 * ## Registration
 *
 * TODO(browser): wire these definitions into `./registry.ts` alongside the
 * other tools (import each `*Tool` and list it in the tools array). This is
 * intentionally left out of this file — registration is owned by the caller.
 */

import path from "path"
import fs from "node:fs"
import { spawn } from "node:child_process"
import { Effect, Schema } from "effect"
import { Global } from "@newhorse/core/global"
import { KeyedMutex } from "@newhorse/core/effect/keyed-mutex"
import { which } from "@newhorse/core/util/which"
import { Process } from "@/util/process"
import { sniffAttachmentMime } from "@/util/media"
import * as Tool from "./tool"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Version of the agent-browser CLI these tools target. The CLI serves its own
 * bundled skills (`agent-browser skills get core`) that always match the
 * installed binary, so this only pins the expected release asset used by the
 * auto-download — it does not enforce a running-binary version.
 */
export const BROWSER_VERSION = "0.34.0"

/**
 * Platform → GitHub release asset map for `vercel-labs/agent-browser`
 * `v${BROWSER_VERSION}` (same asset naming the package's own postinstall uses).
 * Windows arm64 runs the x64 binary through emulation.
 */
export const BROWSER_PLATFORM = {
  "x64-win32": { asset: "agent-browser-win32-x64.exe", ext: ".exe" },
  "arm64-win32": { asset: "agent-browser-win32-x64.exe", ext: ".exe" },
  "x64-linux": { asset: "agent-browser-linux-x64", ext: "" },
  "arm64-linux": { asset: "agent-browser-linux-arm64", ext: "" },
  "x64-darwin": { asset: "agent-browser-darwin-x64", ext: "" },
  "arm64-darwin": { asset: "agent-browser-darwin-arm64", ext: "" },
} as const

/**
 * TODO(browser): pin sha256 for each BROWSER_PLATFORM asset and fill
 * `BROWSER_CHECKSUMS` (computed from the actual release assets). The download
 * step is wired up (`downloadAgentBrowser`); when a checksum is present for the
 * running platform it is verified before the binary is cached. Until pinned,
 * verification is skipped and a size sanity check is used instead.
 */
export const BROWSER_CHECKSUMS: Record<string, string> = {}

const BINARY_NAME = process.platform === "win32" ? "agent-browser.exe" : "agent-browser"

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_TIMEOUT_MS = 300_000

const MAX_URL_LENGTH = 2048
const MAX_SELECTOR_LENGTH = 512
const MAX_TEXT_LENGTH = 4000
const MAX_SCRIPT_LENGTH = 20_000
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024

const PERMISSION = "browser"

const COLD_START_BACKOFF_MS = [200, 500, 1000] as const
const RESET_COMMAND_TIMEOUT_MS = 5_000

const sessionLocks = KeyedMutex.makeUnsafe<string>()

/**
 * Thrown by `resolveAgentBrowserPath` when no agent-browser binary is found
 * (and no `AGENT_BROWSER_PATH` override was set). `ensureAgentBrowserBinary`
 * catches this specifically to attempt an auto-download before surfacing the
 * install-instructions error.
 */
export class AgentBrowserNotFoundError extends Error {}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

export interface ResolveBrowserPathOptions {
  env?: NodeJS.ProcessEnv
  binDir?: string
}

function notFoundMessage(cached: string): string {
  return [
    `agent-browser binary not found. These browser tools spawn the native 'agent-browser' CLI (vercel-labs/agent-browser).`,
    ``,
    `Install it one of these ways:`,
    `  1. Set AGENT_BROWSER_PATH=/path/to/agent-browser to point at the executable.`,
    `  2. Install globally:  npm i -g agent-browser  then run  agent-browser install  (downloads Chrome for Testing).`,
    `  3. Build from source: cargo install agent-browser.`,
    ``,
    `Locations checked, in order: AGENT_BROWSER_PATH -> PATH -> ${cached}`,
    `Automatic download of the pinned release binary was attempted but failed.`,
  ].join("\n")
}

/**
 * Resolve the `agent-browser` executable:
 * `AGENT_BROWSER_PATH` env → `PATH` lookup → cached copy in `Global.Path.bin`.
 * Throws a descriptive error (with install instructions) when none is found.
 */
export function resolveAgentBrowserPath(opts: ResolveBrowserPathOptions = {}): string {
  const env = opts.env ?? process.env
  const explicit = env.AGENT_BROWSER_PATH
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit
    throw new Error(
      `AGENT_BROWSER_PATH is set to '${explicit}' but no such file exists. Point it at the agent-browser executable.`,
    )
  }
  const onPath = which(BINARY_NAME, env)
  if (onPath) return onPath
  const cached = path.join(opts.binDir ?? Global.Path.bin, BINARY_NAME)
  if (fs.existsSync(cached)) return cached
  throw new AgentBrowserNotFoundError(notFoundMessage(cached))
}

// ---------------------------------------------------------------------------
// Auto-download (first-use)
// ---------------------------------------------------------------------------

/** agent-browser's release assets are raw executables; anything under this size is a truncated/HTML download. */
const MIN_BINARY_BYTES = 100_000

let downloadPromise: Promise<string | null> | null = null

/** Test seam (mirrors ast-grep's `setAstGrepRunnerForTest`). Reset with null. */
let downloadOverride: ((binDir?: string) => Promise<string | null>) | undefined
export function setBrowserDownloadForTest(fn: ((binDir?: string) => Promise<string | null>) | null): void {
  downloadOverride = fn ?? undefined
}

/**
 * Download the pinned agent-browser release binary for the running platform
 * into `Global.Path.bin` (or `binDir`) and cache it there. Returns the cached
 * path, or null when the platform is unsupported or the download failed.
 */
export function downloadAgentBrowser(binDir?: string): Promise<string | null> {
  const fn = downloadOverride
  if (fn) return fn(binDir)
  if (downloadPromise) return downloadPromise
  downloadPromise = doDownload(binDir)
    .catch((error: unknown) => {
      console.error(
        `[agent-browser] failed to download binary: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    })
    .finally(() => {
      downloadPromise = null
    })
  return downloadPromise
}

async function doDownload(binDir?: string): Promise<string | null> {
  const target = path.join(binDir ?? Global.Path.bin, BINARY_NAME)
  if (fs.existsSync(target) && fs.statSync(target).size > MIN_BINARY_BYTES) return target

  const platformKey = `${process.arch}-${process.platform}` as keyof typeof BROWSER_PLATFORM
  const config = BROWSER_PLATFORM[platformKey]
  if (!config) {
    console.error(`[agent-browser] unsupported platform: ${platformKey}`)
    return null
  }

  const url = `https://github.com/vercel-labs/agent-browser/releases/download/v${BROWSER_VERSION}/${config.asset}`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength < MIN_BINARY_BYTES) throw new Error(`download from ${url} looks invalid (${bytes.byteLength} bytes)`)

  // Checksum verification runs only when a sha256 is pinned for this platform.
  const expected = BROWSER_CHECKSUMS[platformKey]
  if (expected) {
    const digest = await sha256Hex(bytes)
    if (digest !== expected) throw new Error(`sha256 mismatch for agent-browser: expected ${expected}, got ${digest}`)
  }

  fs.writeFileSync(target, bytes)
  if (process.platform !== "win32") fs.chmodSync(target, 0o755)
  return target
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto")
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Resolve the agent-browser executable, auto-downloading the pinned release
 * binary on first use. Precedence: `AGENT_BROWSER_PATH` → `PATH` → cached
 * download. An explicit `AGENT_BROWSER_PATH` that does not exist is never
 * overridden. Throws the install-instructions error when nothing can be found.
 */
export async function ensureAgentBrowserBinary(opts: ResolveBrowserPathOptions = {}): Promise<string> {
  try {
    return resolveAgentBrowserPath(opts)
  } catch (error) {
    if (!(error instanceof AgentBrowserNotFoundError)) throw error
    const downloaded = await downloadAgentBrowser(opts.binDir)
    if (downloaded) return downloaded
    throw error
  }
}

// ---------------------------------------------------------------------------
// Process spawn + response parsing
// ---------------------------------------------------------------------------

export interface RunAgentBrowserResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Spawn `agent-browser` with the given args and a hard timeout. The CLI keeps
 * a per-session daemon alive, so a timeout kills the client only; the daemon
 * (and any launched Chrome) is left to agent-browser's own idle timeout.
 */
export async function runAgentBrowser(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<RunAgentBrowserResult> {
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const result = await Process.run([binary, ...args], { abort: controller.signal })
    return { code: result.code, stdout: result.stdout.toString(), stderr: result.stderr.toString(), timedOut: false }
  } catch (err) {
    if (controller.signal.aborted) {
      return { code: 1, stdout: "", stderr: `Timed out after ${timeoutMs}ms`, timedOut: true }
    }
    if (err instanceof Process.RunFailedError) {
      return { code: err.code, stdout: err.stdout.toString(), stderr: err.stderr.toString(), timedOut: false }
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export interface AgentBrowserResponse {
  success: boolean
  data?: unknown
  error?: string
  code?: string
  warning?: string
}

/**
 * Parse the CLI's `--json` stdout. In JSON mode the response object is printed
 * on a single line, but startup logs can precede it on stdout, so scan for the
 * first line that parses to an object with a `success` field.
 */
export function parseBrowserResponse(stdout: string, stderr: string): AgentBrowserResponse {
  const trimmed = stdout.trim()
  if (trimmed) {
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim()
      if (!candidate) continue
      try {
        const parsed: unknown = JSON.parse(candidate)
        if (parsed && typeof parsed === "object" && "success" in parsed) {
          return parsed as AgentBrowserResponse
        }
      } catch {
        // Not a JSON line — keep scanning.
      }
    }
  }
  const stderrText = stderr.trim()
  if (stderrText) return { success: false, error: stderrText.slice(0, 2000) }
  if (trimmed) return { success: false, error: `agent-browser returned non-JSON output:\n${trimmed.slice(0, 1000)}` }
  return { success: false, error: "agent-browser produced no output" }
}

// ---------------------------------------------------------------------------
// Validation (parameter / injection guards)
// ---------------------------------------------------------------------------

function truncateForError(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value
}

function toError(cause: unknown): Error {
  if (cause && cause instanceof Error) return cause
  return new Error(String(cause))
}

export function assertSafeUrl(url: string): void {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(`URL must start with http:// or https:// (got '${truncateForError(url)}')`)
  }
  if (url.length > MAX_URL_LENGTH) throw new Error(`URL too long (max ${MAX_URL_LENGTH} characters)`)
  if (/[\u0000-\u001f]/.test(url)) throw new Error("URL contains control characters")
  try {
    void new URL(url)
  } catch {
    throw new Error(`Invalid URL: '${truncateForError(url)}'`)
  }
}

export function assertSafeArg(value: string, label: string, maxLength: number): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`)
  if (value.length > maxLength) throw new Error(`${label} too long (max ${maxLength} characters)`)
  if (value.includes("\u0000")) throw new Error(`${label} must not contain NUL bytes`)
}

/**
 * Validate a value passed as a positional argument the agent-browser CLI may
 * treat as a flag when it starts with `-` (e.g. `eval --stdin`, `type --clear`).
 */
export function assertSafePositional(value: string, label: string, maxLength: number): void {
  assertSafeArg(value, label, maxLength)
  if (value.startsWith("-")) throw new Error(`${label} must not start with '-' (reserved for CLI flags)`)
}

/** Free text that may legitimately start with `-` but must not equal a flag token. */
export function assertSafeText(value: string, label: string, maxLength: number): void {
  assertSafeArg(value, label, maxLength)
  if (value === "--clear" || value === "--delay") {
    throw new Error(`${label} must not be '${value}' (reserved for CLI flags)`)
  }
}

// ---------------------------------------------------------------------------
// Session naming + CLI arg building
// ---------------------------------------------------------------------------

/**
 * Derive a stable agent-browser session name from an opencode session id.
 * agent-browser session names allow only `[A-Za-z0-9_-]`.
 */
export function agentBrowserSessionName(sessionID: string): string {
  const sanitized = sessionID
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
  return `nh-${sanitized || "default"}`
}

export type BrowserCommand =
  | { kind: "open"; url: string; headed: boolean }
  | { kind: "snapshot"; interactive: boolean; compact: boolean; selector?: string }
  | { kind: "click"; selector: string; newTab: boolean }
  | { kind: "type"; selector: string; text: string; clear: boolean }
  | { kind: "eval"; script: string }
  | { kind: "screenshot"; path?: string; selector?: string; full: boolean }
  | { kind: "session"; action: "info" | "close" }

/**
 * Build the `agent-browser` args (after the binary) for a command. Global flags
 * (`--json`, `--session`, `--headed`) are parsed from anywhere in the arg list
 * by the CLI and stripped from the command args, so they are always placed
 * first. Only `open` sends `--headed`; follow-up commands never do, so they
 * cannot flip an already-running session's launch mode.
 */
export function buildBrowserArgs(command: BrowserCommand, sessionName: string): string[] {
  const args = ["--json", "--session", sessionName]
  if (command.kind === "open" && !command.headed) args.push("--headed", "false")

  switch (command.kind) {
    case "open":
      args.push("open", command.url)
      break
    case "snapshot":
      args.push("snapshot")
      if (command.interactive) args.push("--interactive")
      if (command.compact) args.push("--compact")
      if (command.selector) args.push("--selector", command.selector)
      break
    case "click":
      args.push("click", command.selector)
      if (command.newTab) args.push("--new-tab")
      break
    case "type":
      args.push("type", command.selector, command.text)
      if (command.clear) args.push("--clear")
      break
    case "eval":
      args.push("eval", command.script)
      break
    case "screenshot":
      args.push("screenshot")
      if (command.selector && command.path) args.push(command.selector, command.path)
      else if (command.selector) args.push(command.selector)
      else if (command.path) args.push(command.path)
      if (command.full) args.push("--full")
      break
    case "session":
      if (command.action === "info") args.push("session", "info")
      else args.push("close")
      break
  }
  return args
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

/**
 * Render a CLI `data` payload into model-facing text. Handles the common
 * agent-browser response shapes: a11y snapshots (`snapshot`), eval results
 * (`result`), navigation (`url`/`title`), text/value/path/count, and arbitrary
 * JSON for everything else.
 */
export function renderBrowserData(data: unknown): string {
  if (data === null || data === undefined) return "(no data)"
  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") return String(data)
  if (typeof data !== "object") return String(data)
  const obj = data as Record<string, unknown>
  if (typeof obj.snapshot === "string") return obj.snapshot
  if (obj.result !== undefined) {
    return typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result, null, 2)
  }
  if (typeof obj.text === "string") return obj.text
  if (typeof obj.value === "string") return obj.value
  if (typeof obj.path === "string") return obj.path
  if (typeof obj.url === "string") {
    const title = typeof obj.title === "string" && obj.title ? obj.title : undefined
    return title ? `${title}\n${obj.url}` : obj.url
  }
  if (typeof obj.count === "number") return String(obj.count)
  if (typeof obj.message === "string") return obj.message
  return JSON.stringify(data, null, 2)
}

function renderSessionInfo(data: unknown): string {
  if (!data || typeof data !== "object") return renderBrowserData(data)
  const obj = data as Record<string, unknown>
  const lines: string[] = []
  lines.push(`Session: ${typeof obj.session === "string" ? obj.session : "unknown"}`)
  if (obj.runtimeError) {
    lines.push(`Runtime error: ${String(obj.runtimeError)}`)
  } else {
    lines.push(`Active: ${Boolean(obj.active)}`)
    if (typeof obj.pid === "number") lines.push(`Pid: ${obj.pid}`)
    if (typeof obj.version === "string") lines.push(`Version: ${obj.version}`)
  }
  if (typeof obj.socketDir === "string") lines.push(`Socket dir: ${obj.socketDir}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Shared spawn helper (Effect)
// ---------------------------------------------------------------------------

function resetBrowserSession(binary: string, sessionName: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    let daemonPid: number | undefined
    yield* Effect.promise(() =>
      runAgentBrowser(binary, buildBrowserArgs({ kind: "session", action: "info" }, sessionName), {
        timeoutMs: RESET_COMMAND_TIMEOUT_MS,
      }).then(async (info) => {
        if (!info.stdout) return
        const parsed = parseBrowserResponse(info.stdout, info.stderr)
        if (!parsed.success || !parsed.data) return
        const data = parsed.data as Record<string, unknown>
        if (typeof data.pid === "number" && data.pid > 0) daemonPid = data.pid
        if (typeof data.socketDir !== "string") return
        try {
          fs.rmSync(data.socketDir, { recursive: true, force: true })
        } catch (cause) {
          void cause
        }
      }),
    ).pipe(Effect.orElseSucceed(() => undefined))
    yield* Effect.promise(() =>
      runAgentBrowser(binary, buildBrowserArgs({ kind: "session", action: "close" }, sessionName), {
        timeoutMs: RESET_COMMAND_TIMEOUT_MS,
      }),
    ).pipe(Effect.orElseSucceed(() => undefined))
    if (daemonPid !== undefined) {
      yield* killProcessTree(daemonPid).pipe(Effect.orElseSucceed(() => undefined))
    }
  })
}

function killProcessTree(pid: number): Effect.Effect<void> {
  return Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const finish = () => resolve()
        if (process.platform === "win32") {
          const child = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
            stdio: "ignore",
            windowsHide: true,
          })
          child.once("exit", finish)
          child.once("error", finish)
        } else {
          try {
            process.kill(-pid, "SIGKILL")
          } catch {
            // pgid kill may not be permitted; fall back to plain kill
            try {
              process.kill(pid, "SIGKILL")
            } catch {
              // already gone
            }
          }
          finish()
        }
      }),
  )
}

/**
 * Spawn `agent-browser` for `command`, serializing concurrent calls per
 * `sessionName` and retrying transient cold-start failures with exponential
 * backoff. Concurrent cold-starts of the same per-session daemon race the
 * daemon's initialization (the second client sees an uninitialized session
 * and dies); the keyed mutex queues calls sharing a session name while calls
 * on different sessions still run in parallel. An empty-stdout attempt with
 * no timeout is treated as a cold-start race: the daemon is reset, the call
 * sleeps for the next backoff slot, and is re-spawned up to
 * `COLD_START_BACKOFF_MS.length` extra times before the original failure is
 * surfaced. Timeouts short-circuit the retry loop — the client was killed,
 * retrying would just race the daemon again.
 */
function runBrowser(
  binary: string,
  command: BrowserCommand,
  sessionName: string,
  opts: { timeoutMs: number },
): Effect.Effect<{ stdout: string; stderr: string; timedOut: boolean }, Error> {
  return sessionLocks.withLock(sessionName)(
    Effect.gen(function* () {
      let last: RunAgentBrowserResult | undefined
      const attempts = COLD_START_BACKOFF_MS.length + 1
      for (let i = 0; i < attempts; i++) {
        const result = yield* Effect.promise(() =>
          runAgentBrowser(binary, buildBrowserArgs(command, sessionName), { timeoutMs: opts.timeoutMs }),
        ).pipe(Effect.mapError((cause) => toError(cause)))
        last = result
        if (result.stdout.trim().length > 0 && !result.timedOut) {
          yield* schedulePostCallCleanup(binary, sessionName)
          return { stdout: result.stdout, stderr: result.stderr, timedOut: false }
        }
        if (result.timedOut) {
          return { stdout: result.stdout, stderr: result.stderr, timedOut: true }
        }
        if (i < attempts - 1) {
          yield* resetBrowserSession(binary, sessionName)
          yield* Effect.sleep(`${COLD_START_BACKOFF_MS[i]} millis`)
        }
      }
      return { stdout: last!.stdout, stderr: last!.stderr, timedOut: last!.timedOut }
    }),
  )
}

/**
 * After a successful browser call, fork a detached fiber that waits a short
 * grace period and then tears down the per-session daemon's process tree
 * (daemon + any Chrome it forked). The grace window lets a follow-up
 * `browser_*` call in the same session reuse the live daemon without paying
 * the cold-start cost; once the window elapses, the daemon and its detached
 * Chrome children are reclaimed so a long-running session does not accumulate
 * orphan Chrome processes. Concurrent calls are already serialized by
 * `sessionLocks.withLock`, so the cleanup runs only after the queue has
 * drained. Failures are swallowed — the next browser call will cold-start.
 */
const POST_CALL_CLEANUP_GRACE_MS = 5_000

function schedulePostCallCleanup(binary: string, sessionName: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Effect.sleep(`${POST_CALL_CLEANUP_GRACE_MS} millis`)
    const info = yield* Effect.promise(() =>
      runAgentBrowser(binary, buildBrowserArgs({ kind: "session", action: "info" }, sessionName), {
        timeoutMs: RESET_COMMAND_TIMEOUT_MS,
      }),
    ).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "", timedOut: false, code: 1 }) as RunAgentBrowserResult))
    if (!info.stdout) return
    const parsed = parseBrowserResponse(info.stdout, info.stderr)
    if (!parsed.success || !parsed.data) return
    if (typeof parsed.data !== "object" || parsed.data === null) return
    const data = parsed.data as { pid?: unknown }
    if (typeof data.pid !== "number" || data.pid <= 0) return
    yield* killProcessTree(data.pid).pipe(Effect.orElseSucceed(() => undefined))
  }).pipe(Effect.forkDetach, Effect.ignore)
}

function timeoutSeconds(value: number | undefined, fallbackMs: number): number {
  if (value === undefined) return fallbackMs
  const ms = value * 1000
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("timeout must be a positive number of seconds")
  return Math.min(ms, MAX_COMMAND_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Tool: browser_open
// ---------------------------------------------------------------------------

export const BrowserOpenParameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "The URL to open (must start with http:// or https://)",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Optional timeout in seconds (max 300). Browser launch on first use can be slow.",
  }),
  headed: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))).annotate({
    description: "Open a visible (headed) browser window. Defaults to headless.",
    default: false,
  }),
})

export const BrowserOpenTool = Tool.define(
  "browser_open",
  Effect.gen(function* () {
    return {
      description: `Open a URL in a headless Chrome browser driven by the native agent-browser CLI (vercel-labs/agent-browser). Launches the browser on first use and navigates the active page to the URL. Follow up with browser_snapshot to read the rendered page, and browser_click / browser_type to interact. Each opencode session gets its own dedicated browser session. Requires the agent-browser binary (AGENT_BROWSER_PATH, PATH, or cached) and a Chrome/Chromium install.`,
      parameters: BrowserOpenParameters,
      execute: (params: Schema.Schema.Type<typeof BrowserOpenParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          assertSafeUrl(params.url)
          yield* ctx.ask({
            permission: PERMISSION,
            patterns: [params.url],
            always: ["*"],
            metadata: { command: "open", url: params.url, headed: params.headed },
          })
          const binary = yield* Effect.promise(() => ensureAgentBrowserBinary())
          const sessionName = agentBrowserSessionName(String(ctx.sessionID))
          const result = yield* runBrowser(
            binary,
            { kind: "open", url: params.url, headed: params.headed },
            sessionName,
            { timeoutMs: timeoutSeconds(params.timeout, 120_000) },
          )
          if (result.timedOut) throw new Error(`agent-browser open timed out after ${result.stderr}`)
          const response = parseBrowserResponse(result.stdout, result.stderr)
          if (!response.success) throw new Error(response.error ?? "agent-browser open failed")
          return {
            title: `browser_open: ${params.url}`,
            output: renderBrowserData(response.data),
            metadata: { session: sessionName, url: params.url, command: "open" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ---------------------------------------------------------------------------
// Tool: browser_snapshot
// ---------------------------------------------------------------------------

export const BrowserSnapshotParameters = Schema.Struct({
  selector: Schema.optional(Schema.String).annotate({
    description:
      "Limit the snapshot to an element, using an @eN element ref from a previous snapshot or a CSS selector",
  }),
  interactive: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))).annotate({
    description: "Include interactive elements with element refs for click/type (default: true)",
    default: true,
  }),
  compact: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))).annotate({
    description: "Compact snapshot (default: false)",
    default: false,
  }),
})

export const BrowserSnapshotTool = Tool.define(
  "browser_snapshot",
  Effect.gen(function* () {
    return {
      description: `Read the current page as an accessibility-tree snapshot with @eN element refs for interaction. This is the primary way to inspect what the browser is showing. Interactive elements are annotated with refs you can pass to browser_click and browser_type. Use a selector to limit the snapshot to a specific element. Requires an open page (see browser_open).`,
      parameters: BrowserSnapshotParameters,
      execute: (params: Schema.Schema.Type<typeof BrowserSnapshotParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.selector !== undefined) assertSafePositional(params.selector, "selector", MAX_SELECTOR_LENGTH)
          yield* ctx.ask({
            permission: PERMISSION,
            patterns: [params.selector ?? "snapshot"],
            always: ["*"],
            metadata: { command: "snapshot", selector: params.selector, interactive: params.interactive },
          })
          const binary = yield* Effect.promise(() => ensureAgentBrowserBinary())
          const sessionName = agentBrowserSessionName(String(ctx.sessionID))
          const result = yield* runBrowser(
            binary,
            {
              kind: "snapshot",
              interactive: params.interactive,
              compact: params.compact,
              selector: params.selector,
            },
            sessionName,
            { timeoutMs: 60_000 },
          )
          if (result.timedOut) throw new Error(`agent-browser snapshot timed out after ${result.stderr}`)
          const response = parseBrowserResponse(result.stdout, result.stderr)
          if (!response.success) throw new Error(response.error ?? "agent-browser snapshot failed")
          return {
            title: "browser_snapshot",
            output: renderBrowserData(response.data),
            metadata: { session: sessionName, command: "snapshot" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ---------------------------------------------------------------------------
// Tool: browser_click
// ---------------------------------------------------------------------------

export const BrowserClickParameters = Schema.Struct({
  selector: Schema.String.annotate({
    description: "Element to click: an @eN element ref from a snapshot or a CSS selector",
  }),
  newTab: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))).annotate({
    description: "Open the clicked link in a new tab (default: false)",
    default: false,
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Optional timeout in seconds (max 300)",
  }),
})

export const BrowserClickTool = Tool.define(
  "browser_click",
  Effect.gen(function* () {
    return {
      description: `Click an element on the current page. Use an @eN element ref from browser_snapshot for reliability, or a CSS selector. After clicking, run browser_snapshot again to see the result.`,
      parameters: BrowserClickParameters,
      execute: (params: Schema.Schema.Type<typeof BrowserClickParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          assertSafePositional(params.selector, "selector", MAX_SELECTOR_LENGTH)
          yield* ctx.ask({
            permission: PERMISSION,
            patterns: [params.selector],
            always: ["*"],
            metadata: { command: "click", selector: params.selector, newTab: params.newTab },
          })
          const binary = yield* Effect.promise(() => ensureAgentBrowserBinary())
          const sessionName = agentBrowserSessionName(String(ctx.sessionID))
          const result = yield* runBrowser(
            binary,
            { kind: "click", selector: params.selector, newTab: params.newTab },
            sessionName,
            { timeoutMs: timeoutSeconds(params.timeout, 60_000) },
          )
          if (result.timedOut) throw new Error(`agent-browser click timed out after ${result.stderr}`)
          const response = parseBrowserResponse(result.stdout, result.stderr)
          if (!response.success) throw new Error(response.error ?? "agent-browser click failed")
          return {
            title: `browser_click: ${params.selector}`,
            output: renderBrowserData(response.data),
            metadata: { session: sessionName, selector: params.selector, command: "click" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ---------------------------------------------------------------------------
// Tool: browser_type
// ---------------------------------------------------------------------------

export const BrowserTypeParameters = Schema.Struct({
  selector: Schema.String.annotate({
    description: "Input element to type into: an @eN element ref from a snapshot or a CSS selector",
  }),
  text: Schema.String.annotate({
    description: "Text to type into the element",
  }),
  clear: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))).annotate({
    description: "Clear the field before typing (default: false)",
    default: false,
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Optional timeout in seconds (max 300)",
  }),
})

export const BrowserTypeTool = Tool.define(
  "browser_type",
  Effect.gen(function* () {
    return {
      description: `Type text into an input element on the current page. Use an @eN element ref from browser_snapshot or a CSS selector. Optionally clear the field first. Run browser_snapshot afterwards to confirm the value was entered.`,
      parameters: BrowserTypeParameters,
      execute: (params: Schema.Schema.Type<typeof BrowserTypeParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          assertSafePositional(params.selector, "selector", MAX_SELECTOR_LENGTH)
          assertSafeText(params.text, "text", MAX_TEXT_LENGTH)
          yield* ctx.ask({
            permission: PERMISSION,
            patterns: [params.selector],
            always: ["*"],
            metadata: { command: "type", selector: params.selector, clear: params.clear },
          })
          const binary = yield* Effect.promise(() => ensureAgentBrowserBinary())
          const sessionName = agentBrowserSessionName(String(ctx.sessionID))
          const result = yield* runBrowser(
            binary,
            { kind: "type", selector: params.selector, text: params.text, clear: params.clear },
            sessionName,
            { timeoutMs: timeoutSeconds(params.timeout, 60_000) },
          )
          if (result.timedOut) throw new Error(`agent-browser type timed out after ${result.stderr}`)
          const response = parseBrowserResponse(result.stdout, result.stderr)
          if (!response.success) throw new Error(response.error ?? "agent-browser type failed")
          return {
            title: `browser_type: ${params.selector}`,
            output: renderBrowserData(response.data),
            metadata: { session: sessionName, selector: params.selector, command: "type" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ---------------------------------------------------------------------------
// Tool: browser_eval
// ---------------------------------------------------------------------------

export const BrowserEvalParameters = Schema.Struct({
  script: Schema.String.annotate({
    description: "JavaScript expression or statements to evaluate in the page context. The result is returned to you.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Optional timeout in seconds (max 300)",
  }),
})

export const BrowserEvalTool = Tool.define(
  "browser_eval",
  Effect.gen(function* () {
    return {
      description: `Evaluate JavaScript in the current page context and return the result. This is powerful: it can read or mutate the DOM, call page APIs, or trigger actions. Use it to extract data or verify state, and prefer browser_snapshot / browser_click / browser_type for routine interaction. The user is always asked before this runs.`,
      parameters: BrowserEvalParameters,
      execute: (params: Schema.Schema.Type<typeof BrowserEvalParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          assertSafePositional(params.script, "script", MAX_SCRIPT_LENGTH)
          yield* ctx.ask({
            permission: PERMISSION,
            patterns: [params.script],
            always: ["*"],
            metadata: { command: "eval", script: params.script },
          })
          const binary = yield* Effect.promise(() => ensureAgentBrowserBinary())
          const sessionName = agentBrowserSessionName(String(ctx.sessionID))
          const result = yield* runBrowser(binary, { kind: "eval", script: params.script }, sessionName, {
            timeoutMs: timeoutSeconds(params.timeout, 60_000),
          })
          if (result.timedOut) throw new Error(`agent-browser eval timed out after ${result.stderr}`)
          const response = parseBrowserResponse(result.stdout, result.stderr)
          if (!response.success) throw new Error(response.error ?? "agent-browser eval failed")
          return {
            title: "browser_eval",
            output: renderBrowserData(response.data),
            metadata: { session: sessionName, command: "eval" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ---------------------------------------------------------------------------
// Tool: browser_screenshot
// ---------------------------------------------------------------------------

export const BrowserScreenshotParameters = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description:
      "Optional file path to save the screenshot to. If omitted, agent-browser chooses a location and the image is returned as an attachment.",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "Limit the screenshot to an element (@eN ref or CSS selector)",
  }),
  full: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))).annotate({
    description: "Capture the full page instead of the viewport (default: false)",
    default: false,
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Optional timeout in seconds (max 300)",
  }),
})

export const BrowserScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    return {
      description: `Take a screenshot of the current page (or a specific element) and return it as an image attachment. Use this to verify visual state, layout, or to capture evidence. For reading text or page structure prefer browser_snapshot.`,
      parameters: BrowserScreenshotParameters,
      execute: (params: Schema.Schema.Type<typeof BrowserScreenshotParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.selector !== undefined) assertSafePositional(params.selector, "selector", MAX_SELECTOR_LENGTH)
          if (params.path !== undefined) assertSafeArg(params.path, "path", 1024)
          yield* ctx.ask({
            permission: PERMISSION,
            patterns: [params.path ?? "screenshot"],
            always: ["*"],
            metadata: { command: "screenshot", selector: params.selector, full: params.full },
          })
          const binary = yield* Effect.promise(() => ensureAgentBrowserBinary())
          const sessionName = agentBrowserSessionName(String(ctx.sessionID))
          const result = yield* runBrowser(
            binary,
            { kind: "screenshot", path: params.path, selector: params.selector, full: params.full },
            sessionName,
            { timeoutMs: timeoutSeconds(params.timeout, 60_000) },
          )
          if (result.timedOut) throw new Error(`agent-browser screenshot timed out after ${result.stderr}`)
          const response = parseBrowserResponse(result.stdout, result.stderr)
          if (!response.success) throw new Error(response.error ?? "agent-browser screenshot failed")

          const data =
            response.data && typeof response.data === "object" ? (response.data as Record<string, unknown>) : {}
          const filePath = typeof data.path === "string" ? data.path : undefined
          if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(
              `agent-browser screenshot did not produce a file (data: ${JSON.stringify(data).slice(0, 500)})`,
            )
          }

          const bytes = yield* Effect.promise(() => fs.promises.readFile(filePath)).pipe(
            Effect.mapError((cause) => toError(cause)),
          )
          if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
            throw new Error(`Screenshot exceeds the ${MAX_SCREENSHOT_BYTES / (1024 * 1024)}MB attachment limit`)
          }
          const mime = sniffAttachmentMime(new Uint8Array(bytes), "image/png")
          const base64 = Buffer.from(bytes).toString("base64")

          return {
            title: "browser_screenshot",
            output: `Screenshot saved to ${filePath}`,
            metadata: { session: sessionName, path: filePath, command: "screenshot" },
            attachments: [
              {
                type: "file" as const,
                mime,
                url: `data:${mime};base64,${base64}`,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ---------------------------------------------------------------------------
// Tool: browser_session
// ---------------------------------------------------------------------------

export const BrowserSessionParameters = Schema.Struct({
  action: Schema.Literals(["info", "close"]).annotate({
    description:
      "'info' reports whether the dedicated browser session (and its daemon) is running. 'close' shuts down the browser and daemon for this opencode session, releasing resources.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Optional timeout in seconds (max 300)",
  }),
})

export const BrowserSessionTool = Tool.define(
  "browser_session",
  Effect.gen(function* () {
    return {
      description: `Inspect or shut down the dedicated agent-browser session for this opencode conversation. 'close' is useful at the end of a browser task to release the headless Chrome and daemon resources. The session is shared by all browser_* tools in this conversation and persists until closed.`,
      parameters: BrowserSessionParameters,
      execute: (params: Schema.Schema.Type<typeof BrowserSessionParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: PERMISSION,
            patterns: [params.action],
            always: ["*"],
            metadata: { command: "session", action: params.action },
          })
          const binary = yield* Effect.promise(() => ensureAgentBrowserBinary())
          const sessionName = agentBrowserSessionName(String(ctx.sessionID))
          const result = yield* runBrowser(
            binary,
            { kind: "session", action: params.action },
            sessionName,
            { timeoutMs: timeoutSeconds(params.timeout, 60_000) },
          )
          if (result.timedOut) throw new Error(`agent-browser session timed out after ${result.stderr}`)
          const response = parseBrowserResponse(result.stdout, result.stderr)
          if (!response.success) throw new Error(response.error ?? `agent-browser session ${params.action} failed`)
          const output = params.action === "info" ? renderSessionInfo(response.data) : renderBrowserData(response.data)
          return {
            title: `browser_session: ${params.action}`,
            output,
            metadata: { session: sessionName, action: params.action, command: "session" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const browserTools = [
  BrowserOpenTool,
  BrowserSnapshotTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserEvalTool,
  BrowserScreenshotTool,
  BrowserSessionTool,
] as const

// ---------------------------------------------------------------------------
// TODO(browser): registration
// ---------------------------------------------------------------------------
// Wire the tools above into `./registry.ts`:
//
//   import {
//     BrowserOpenTool, BrowserSnapshotTool, BrowserClickTool, BrowserTypeTool,
//     BrowserEvalTool, BrowserScreenshotTool, BrowserSessionTool,
//   } from "./browser"
//
// then resolve each with `yield*` in the registry's tool list alongside
// WebFetchTool / WebSearchTool. `browserTools` above is a convenience array.
// Registration is intentionally left to the caller per the task brief.

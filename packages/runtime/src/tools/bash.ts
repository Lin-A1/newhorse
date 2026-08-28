import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { fail } from "./common"
import type { Tool, ToolCtx } from "@newhorse/core"

const MAX_TIMEOUT = 60_000
const MAX_OUTPUT = 60_000

/**
 * Execute a shell command in the workspace. M3.5 §2.2:
 *   - bash is NOT constrained by the fs sandbox — enabling it authorizes this
 *     session to read/write/execute any reachable path with the process user's
 *     permissions. This boundary is explicit, not implied by fs-tool sandboxing.
 *   - The session must opt in explicitly (createBuiltinTools({ enableBash })).
 *   - cwd is pinned to the workspace (the only free soft constraint).
 *   - A model-supplied timeoutMs is clamped to a hard cap.
 *   - A non-zero exitCode is DATA (the model self-corrects), not an error;
 *     `isError` is reserved for infrastructure failures (spawn fail, kill).
 *   - The command is not sanitized — it IS the intent; the trust boundary is the
 *     user's switch (sanitizing would create false safety).
 */
export function createBashTool(workspace: string): Tool {
  return {
    name: "bash",
    description: `Execute a shell command. Working directory is the workspace root: ${workspace}`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        timeoutMs: { type: "number", description: `Optional timeout in ms (clamped to ${MAX_TIMEOUT}).` },
      },
      required: ["command"],
    },
    execute: async (input: unknown, ctx?: ToolCtx) => {
      const { command, timeoutMs } = (input ?? {}) as { command?: string; timeoutMs?: number }
      if (!command) return fail("command is required")
      // Default to the hard cap when the model omits timeoutMs; clamp any
      // supplied value into [1, MAX_TIMEOUT] so a 0/negative/NaN never becomes a
      // 1ms kill-all default.
      const timeout = clamp(Math.floor(timeoutMs ?? MAX_TIMEOUT), 1, MAX_TIMEOUT)
      return run(command, resolve(workspace), timeout, ctx?.signal)
    },
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n) || n < lo) return lo
  return n > hi ? hi : n
}

async function run(command: string, cwd: string, timeout: number, signal?: AbortSignal): Promise<unknown> {
  const shell = process.platform === "win32"
    ? { cmd: "cmd", args: ["/d", "/s", "/c", command] }
    : { cmd: "/bin/sh", args: ["-c", command] }

  const child = spawn(shell.cmd, shell.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  let done = false
  let timedOut = false

  const kill = () => {
    if (child.exitCode !== null) return
    // Windows: taskkill /T /F kills the whole tree (proc.kill() only kills the
    // direct child; grandchildren via cmd /c would become orphans).
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      child.kill("SIGKILL")
    }
  }

  const onAbort = () => kill()
  signal?.addEventListener("abort", onAbort, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeout)

  const finish = (code: number | null): Record<string, unknown> => {
    done = true
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
    const stdoutTrunc = stdout.length > MAX_OUTPUT
    const stderrTrunc = stderr.length > MAX_OUTPUT
    return {
      command,
      exitCode: code,
      stdout: stdout.slice(0, MAX_OUTPUT),
      stderr: stderr.slice(0, MAX_OUTPUT),
      stdoutTruncated: stdoutTrunc,
      stderrTruncated: stderrTrunc,
      timedOut,
    }
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8")
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8")
  })

  return new Promise<unknown>((resolvePromise) => {
    child.on("close", (code) => resolvePromise(finish(code)))
    child.on("error", (e) => {
      // A spawn failure (e.g. ENOENT) must also release the timeout + abort
      // listener, exactly as `finish` does, so nothing leaks across calls.
      if (!done) {
        done = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        resolvePromise(fail(`failed to spawn: ${e.message}`))
      }
    })
  })
}

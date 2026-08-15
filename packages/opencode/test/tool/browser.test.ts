import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import path from "path"
import fs from "node:fs"
import os from "node:os"
import {
  assertSafeArg,
  assertSafePositional,
  assertSafeText,
  assertSafeUrl,
  agentBrowserSessionName,
  ensureAgentBrowserBinary,
  setBrowserDownloadForTest,
  BrowserEvalParameters,
  BrowserOpenParameters,
  BrowserSnapshotParameters,
  buildBrowserArgs,
  parseBrowserResponse,
  renderBrowserData,
  resolveAgentBrowserPath,
  runAgentBrowser,
} from "../../src/tool/browser"

const BINARY_NAME = process.platform === "win32" ? "agent-browser.exe" : "agent-browser"

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "browser-tool-test-"))
}

function makeFakeBinary(dir: string): string {
  const file = path.join(dir, BINARY_NAME)
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8")
  if (process.platform !== "win32") fs.chmodSync(file, 0o755)
  return file
}

describe("resolveAgentBrowserPath", () => {
  test("uses AGENT_BROWSER_PATH when it points at an existing file", () => {
    const dir = makeTempDir()
    const file = path.join(dir, "my-agent-browser")
    fs.writeFileSync(file, "", "utf8")
    const env = { AGENT_BROWSER_PATH: file, PATH: "" }
    expect(resolveAgentBrowserPath({ env, binDir: dir })).toBe(file)
  })

  test("throws a descriptive error when AGENT_BROWSER_PATH is set but missing", () => {
    const env = { AGENT_BROWSER_PATH: "C:/definitely/missing/agent-browser", PATH: "" }
    expect(() => resolveAgentBrowserPath({ env, binDir: makeTempDir() })).toThrow(/AGENT_BROWSER_PATH/)
  })

  test("finds the binary on PATH", () => {
    const dir = makeTempDir()
    makeFakeBinary(dir)
    const env = { PATH: dir }
    const found = resolveAgentBrowserPath({ env, binDir: makeTempDir() })
    expect(found).toBe(path.join(dir, BINARY_NAME))
  })

  test("falls back to the cached binary in binDir", () => {
    const dir = makeTempDir()
    const cached = makeFakeBinary(dir)
    expect(resolveAgentBrowserPath({ env: { PATH: "" }, binDir: dir })).toBe(cached)
  })

  test("throws install instructions when not found anywhere", () => {
    expect(() => resolveAgentBrowserPath({ env: { PATH: "" }, binDir: makeTempDir() })).toThrow(/agent-browser binary not found/)
  })
})

describe("agentBrowserSessionName", () => {
  test("keeps alphanumeric, dash and underscore", () => {
    expect(agentBrowserSessionName("ses_abc123")).toBe("nh-ses_abc123")
  })
  test("sanitizes unsafe characters", () => {
    expect(agentBrowserSessionName("ses with spaces!/x")).toBe("nh-ses-with-spaces-x")
  })
  test("collapses repeated separators and trims edges", () => {
    expect(agentBrowserSessionName("--__ses__--")).toBe("nh-ses")
  })
  test("falls back to default when nothing survives", () => {
    expect(agentBrowserSessionName("!!!" )).toBe("nh-default")
  })
})

describe("validation", () => {
  test("assertSafeUrl accepts http and https", () => {
    expect(() => assertSafeUrl("https://example.com/path?q=1")).not.toThrow()
    expect(() => assertSafeUrl("http://localhost:3000")).not.toThrow()
  })

  test("assertSafeUrl rejects non-http(s) schemes", () => {
    expect(() => assertSafeUrl("javascript:alert(1)")).toThrow(/must start with http/)
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(/must start with http/)
    expect(() => assertSafeUrl("data:text/html,<script>")).toThrow(/must start with http/)
    expect(() => assertSafeUrl("ftp://example.com")).toThrow(/must start with http/)
  })

  test("assertSafeUrl rejects control characters and invalid URLs", () => {
    expect(() => assertSafeUrl("https://example.com/\u0000bad")).toThrow(/control characters/)
    expect(() => assertSafeUrl("https://exa mple.com")).toThrow(/Invalid URL/)
  })

  test("assertSafePositional rejects flag-like values", () => {
    expect(() => assertSafePositional("@e1", "selector", 512)).not.toThrow()
    expect(() => assertSafePositional("#main > a", "selector", 512)).not.toThrow()
    expect(() => assertSafePositional("--clear", "selector", 512)).toThrow(/must not start with '-/)
    expect(() => assertSafePositional("-foo", "script", 512)).toThrow(/must not start with '-/)
    expect(() => assertSafePositional("", "selector", 512)).toThrow(/must not be empty/)
  })

  test("assertSafeText allows leading dashes but rejects flag tokens", () => {
    expect(() => assertSafeText("hello world", "text", 4000)).not.toThrow()
    expect(() => assertSafeText("-42", "text", 4000)).not.toThrow()
    expect(() => assertSafeText("--clear", "text", 4000)).toThrow(/reserved for CLI flags/)
    expect(() => assertSafeText("--delay", "text", 4000)).toThrow(/reserved for CLI flags/)
  })

  test("assertSafeArg rejects empty and NUL values", () => {
    expect(() => assertSafeArg("   ", "path", 1024)).toThrow(/must not be empty/)
    expect(() => assertSafeArg("x\u0000y", "path", 1024)).toThrow(/NUL bytes/)
  })
})

describe("buildBrowserArgs", () => {
  test("open is headless by default", () => {
    expect(buildBrowserArgs({ kind: "open", url: "https://example.com", headed: false }, "nh-s")).toEqual([
      "--json",
      "--session",
      "nh-s",
      "--headed",
      "false",
      "open",
      "https://example.com",
    ])
  })

  test("open headed does not send --headed", () => {
    const args = buildBrowserArgs({ kind: "open", url: "https://example.com", headed: true }, "nh-s")
    expect(args).not.toContain("--headed")
    expect(args).toContain("open")
  })

  test("snapshot with interactive, compact and selector", () => {
    expect(
      buildBrowserArgs({ kind: "snapshot", interactive: true, compact: true, selector: "@e3" }, "nh-s"),
    ).toEqual(["--json", "--session", "nh-s", "snapshot", "--interactive", "--compact", "--selector", "@e3"])
  })

  test("snapshot default interactive", () => {
    expect(buildBrowserArgs({ kind: "snapshot", interactive: true, compact: false }, "nh-s")).toEqual([
      "--json",
      "--session",
      "nh-s",
      "snapshot",
      "--interactive",
    ])
  })

  test("click with new tab", () => {
    expect(buildBrowserArgs({ kind: "click", selector: "@e1", newTab: true }, "nh-s")).toEqual([
      "--json",
      "--session",
      "nh-s",
      "click",
      "@e1",
      "--new-tab",
    ])
  })

  test("type with clear", () => {
    expect(buildBrowserArgs({ kind: "type", selector: "#input", text: "hello", clear: true }, "nh-s")).toEqual([
      "--json",
      "--session",
      "nh-s",
      "type",
      "#input",
      "hello",
      "--clear",
    ])
  })

  test("eval", () => {
    expect(buildBrowserArgs({ kind: "eval", script: "document.title" }, "nh-s")).toEqual([
      "--json",
      "--session",
      "nh-s",
      "eval",
      "document.title",
    ])
  })

  test("screenshot with selector, path and full page", () => {
    expect(buildBrowserArgs({ kind: "screenshot", selector: "@e2", path: "/tmp/s.png", full: true }, "nh-s")).toEqual([
      "--json",
      "--session",
      "nh-s",
      "screenshot",
      "@e2",
      "/tmp/s.png",
      "--full",
    ])
  })

  test("screenshot without selector/path", () => {
    expect(buildBrowserArgs({ kind: "screenshot", selector: undefined, path: undefined, full: false }, "nh-s")).toEqual([
      "--json",
      "--session",
      "nh-s",
      "screenshot",
    ])
  })

  test("session info and close", () => {
    expect(buildBrowserArgs({ kind: "session", action: "info" }, "nh-s")).toEqual([
      "--json",
      "--session",
      "nh-s",
      "session",
      "info",
    ])
    expect(buildBrowserArgs({ kind: "session", action: "close" }, "nh-s")).toEqual(["--json", "--session", "nh-s", "close"])
  })
})

describe("parseBrowserResponse", () => {
  test("parses a success line", () => {
    const parsed = parseBrowserResponse('{"success":true,"data":{"url":"https://example.com"}}', "")
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ url: "https://example.com" })
  })

  test("parses an error line", () => {
    const parsed = parseBrowserResponse('{"success":false,"error":"no page open"}', "")
    expect(parsed.success).toBe(false)
    expect(parsed.error).toBe("no page open")
  })

  test("skips non-JSON startup lines before the response", () => {
    const stdout = ["[agent-browser] starting daemon...", '{"success":true,"data":{"count":1}}'].join("\n")
    const parsed = parseBrowserResponse(stdout, "")
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ count: 1 })
  })

  test("falls back to stderr when stdout is not JSON", () => {
    const parsed = parseBrowserResponse("random log line", "daemon failed to start")
    expect(parsed.success).toBe(false)
    expect(parsed.error).toContain("daemon failed to start")
  })

  test("reports empty output", () => {
    const parsed = parseBrowserResponse("", "")
    expect(parsed.success).toBe(false)
    expect(parsed.error).toContain("no output")
  })
})

describe("renderBrowserData", () => {
  test("renders an a11y snapshot string", () => {
    expect(renderBrowserData({ snapshot: "root\n  button @e1" })).toBe("root\n  button @e1")
  })

  test("renders eval results as JSON", () => {
    expect(renderBrowserData({ result: { title: "Home" } })).toBe(JSON.stringify({ title: "Home" }, null, 2))
  })

  test("renders navigation url/title", () => {
    expect(renderBrowserData({ url: "https://example.com", title: "Example" })).toBe("Example\nhttps://example.com")
  })

  test("renders plain fields", () => {
    expect(renderBrowserData({ text: "hello" })).toBe("hello")
    expect(renderBrowserData({ value: "42" })).toBe("42")
    expect(renderBrowserData({ path: "/tmp/s.png" })).toBe("/tmp/s.png")
    expect(renderBrowserData({ count: 3 })).toBe("3")
  })

  test("renders null and arbitrary objects", () => {
    expect(renderBrowserData(null)).toBe("(no data)")
    expect(renderBrowserData(undefined)).toBe("(no data)")
    const obj = { nested: { deep: true } }
    expect(renderBrowserData(obj)).toBe(JSON.stringify(obj, null, 2))
  })
})

describe("parameter schemas", () => {
  test("browser_open decodes with headless default", () => {
    const decoded = Schema.decodeUnknownSync(BrowserOpenParameters)({ url: "https://example.com" })
    expect(decoded.url).toBe("https://example.com")
    expect(decoded.headed).toBe(false)
  })

  test("browser_open requires a URL", () => {
    expect(() => Schema.decodeUnknownSync(BrowserOpenParameters)({})).toThrow()
  })

  test("browser_snapshot defaults interactive to true", () => {
    const decoded = Schema.decodeUnknownSync(BrowserSnapshotParameters)({})
    expect(decoded.interactive).toBe(true)
    expect(decoded.compact).toBe(false)
  })

  test("browser_eval requires a script", () => {
    expect(() => Schema.decodeUnknownSync(BrowserEvalParameters)({})).toThrow()
    const decoded = Schema.decodeUnknownSync(BrowserEvalParameters)({ script: "1 + 1" })
    expect(decoded.script).toBe("1 + 1")
  })
})

describe("runAgentBrowser", () => {
  test("returns stdout from a successful run", async () => {
    const result = await runAgentBrowser(
      process.execPath,
      ["-e", 'console.log(JSON.stringify({success:true,data:{url:"http://x"}}))'],
    )
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toContain("success")
  })

  test("reports a timeout instead of hanging", async () => {
    const result = await runAgentBrowser(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.stdout).toBe("")
  })
})

describe("ensureAgentBrowserBinary", () => {
  afterEach(() => setBrowserDownloadForTest(null))

  test("auto-downloads when no binary is present", async () => {
    const dir = makeTempDir()
    const downloaded = path.join(dir, "downloaded-agent-browser")
    setBrowserDownloadForTest(() => Promise.resolve(downloaded))
    const result = await ensureAgentBrowserBinary({ env: { PATH: "" }, binDir: dir })
    expect(result).toBe(downloaded)
  })

  test("surfaces install instructions when the download fails", async () => {
    const dir = makeTempDir()
    setBrowserDownloadForTest(() => Promise.resolve(null))
    await expect(ensureAgentBrowserBinary({ env: { PATH: "" }, binDir: dir })).rejects.toThrow(
      /agent-browser binary not found/,
    )
  })

  test("does not override an explicit AGENT_BROWSER_PATH with a download", async () => {
    const dir = makeTempDir()
    setBrowserDownloadForTest(() => Promise.resolve(path.join(dir, "should-not-be-used")))
    const env = { AGENT_BROWSER_PATH: "C:/definitely/missing/agent-browser", PATH: "" }
    await expect(ensureAgentBrowserBinary({ env, binDir: dir })).rejects.toThrow(/AGENT_BROWSER_PATH/)
  })
})

import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import type { Fetcher } from "@newhorse/llm"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

function sse(payload: string): Response {
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
}

describe("runtime app", () => {
  it("runs a single prompt through admission → turn → history", async () => {
    const payload = [
      "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hello" }, finish_reason: null }] }) + "\n\n",
      "data: " + JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")

    const fetch: Fetcher = async () => sse(payload)
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://api.example.com", apiKey: "k" },
      model: "test-model",
      workspace: "/proj",
      fetch: fetch as never,
    })

    const summary = await app.prompt("hi")
    expect(summary.step).toBe(1)
    expect(summary.finish).toBe("stop")

    const history = await app.resume()
    const user = history.messages.find((m) => m.kind === "user")
    const assistant = history.messages.find((m) => m.kind === "assistant")
    expect(user?.text).toBe("hi")
    expect(assistant?.kind).toBe("assistant")
    const text = (assistant as { content?: { type: "text"; text: string }[] } | undefined)?.content?.filter((p) => p.type === "text").map((p) => p.text).join("")
    expect(text).toBe("Hello world")
  })

  it("emits live streamed events on onEvent and unsubscribes", async () => {
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "live" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", fetch: fetch as never })

    const texts: string[] = []
    const off = app.onEvent((e) => {
      if (e.type === "text") texts.push(e.text)
    })
    await app.prompt("hi")
    off()
    // one delta, so one text event
    expect(texts).toEqual(["live"])
  })

  it("persists history across a real restart via dataDir (SQLite)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-app-"))
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "persisted answer" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)
    try {
      const app1 = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "fixed", dataDir: dir, fetch: fetch as never })
      await app1.prompt("hi")

      const app2 = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "fixed", dataDir: dir, fetch: fetch as never })
      const history = await app2.resume()
      expect(history.id).toBe("fixed")
      const assistant = history.messages.find((m) => m.kind === "assistant")
      const text = (assistant as { content?: { type: "text"; text: string }[] } | undefined)?.content?.filter((p) => p.type === "text").map((p) => p.text).join("")
      expect(text).toBe("persisted answer")
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("runs a realistic OpenAI multi-turn wire: fragmented tool-call then result then final text", async () => {
    const turn1 = [
      'data: ' + JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning_content: "let me" }, finish_reason: null }] }) + "\n\n",
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: '{"q":' } }] }, finish_reason: null }] }) + "\n\n",
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    const turn2 = ["data: " + JSON.stringify({ choices: [{ delta: { content: "found it" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")

    let call = 0
    const fetch: Fetcher = async () => sse(call++ === 0 ? turn1 : turn2)
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://api.example.com", apiKey: "k" },
      model: "test-model",
      workspace: "/proj",
      tools: [{ name: "search", execute: async () => ({ n: 2 }) }],
      fetch: fetch as never,
    })

    await app.prompt("search something")

    const history = await app.resume()
    const tool = history.messages.find((m) => m.kind === "tool")
    expect((tool as { callId?: string } | undefined)?.callId).toBe("call_1")
    const assistant = history.messages.filter((m) => m.kind === "assistant")
    const finalText = assistant
      .at(-1)!
      .content.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
    expect(finalText).toBe("found it")
  })

  it("emits tool-result and done events to onEvent", async () => {
    const turn1 = [
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: '{"q":"a"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    const turn2 = ["data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    let call = 0
    const fetch: Fetcher = async () => sse(call++ === 0 ? turn1 : turn2)
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", tools: [{ name: "search", execute: async () => ({ n: 7 }) }], fetch: fetch as never })

    const toolResults: unknown[] = []
    const dones: unknown[] = []
    app.onEvent((e) => {
      if (e.type === "tool-result") toolResults.push(e)
      if (e.type === "done") dones.push(e)
    })
    await app.prompt("go")
    expect(toolResults.length).toBe(1)
    expect((toolResults[0] as { name: string }).name).toBe("search")
    expect(dones.length).toBe(1)
  })

  it("does not silently succeed on a provider-error (emits error)", async () => {
    // Real wire: openai-responses `response.failed` maps to a canonical
    // `provider-error` (loop.ts sets finish="error", never "stop").
    const payload = [
      "data: " + JSON.stringify({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    const fetch: Fetcher = async () => sse(payload)
    const app = await createApp({ provider: { kind: "openai-responses", baseUrl: "https://x", apiKey: "k" }, model: "m", fetch: fetch as never })
    const errors: unknown[] = []
    app.onEvent((e) => {
      if (e.type === "error") errors.push(e)
    })
    const result = await app.prompt("hi")
    // provider-error sets finish="error" (not "stop") and emits an error event;
    // the run still settles (not a crash) but the failure is surfaced to the shell.
    expect(errors.length).toBe(1)
    expect(result.finish).toBe("error")
    expect(result.needsContinuation).toBe(false)
  })

  it("reuses the system context message across repeated prompts in a session", async () => {
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)
    const dir = await mkdtemp(join(tmpdir(), "nh-sys-"))
    try {
      const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "s", dataDir: dir, workspace: "G:/Code/Agents/Custom/newhorse", fetch: fetch as never })
      await app.prompt("first")
      await app.prompt("second")
      const history = await app.resume()
      const systemMessages = history.messages.filter((m) => m.kind === "system")
      expect(systemMessages.length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("interrupt() cancels a live stream and does not poison later prompts on the same app", async () => {
    // One app whose fetch is stateful: first call = held (interruptible) stream,
    // later calls = a completing stream. This proves the same app, after an
    // interrupt, can still run a later prompt (the one-shot-controller bug would
    // silently no-op the second prompt).
    let call = 0
    let cancelled = false
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" },
      model: "m",
      fetch: (async () => {
        call += 1
        if (call === 1) {
          return new Response(new ReadableStream({
            start(controller) {
              const push = () => {
                if (cancelled) return
                controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] }) + "\n\n"))
                setTimeout(push, 5)
              }
              push()
            },
          }), { status: 200, headers: { "content-type": "text/event-stream" } })
        }
        return sse(['data: ' + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join(""))
      }) as unknown as Fetcher,
    })

    const run = app.prompt("go")
    await Bun.sleep(30)
    cancelled = true
    app.interrupt()
    const result = await run
    expect(result.needsContinuation).toBe(false)
    expect(result.finish).toBe("interrupted")

    // The cancellation must have appended Session.Interrupted exactly once, so
    // the registry reflects an interrupted session (not a double append).
    const rows = await app.listSessions()
    expect(rows.some((r) => r.status === "interrupted")).toBe(true)

    // Same app, later prompt — must actually run (call 2 returns a real stream).
    const r2 = await app.prompt("again")
    expect(call).toBe(2)
    expect(r2.needsContinuation).toBe(false)
  })

  it("listSessions() queries the session registry", async () => {
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    const fetch: Fetcher = async () => sse(payload)
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "fixed", workspace: "/w", fetch: fetch as never })
    await app.prompt("hi")
    const rows = await app.listSessions()
    expect(rows.some((r) => r.sessionId === "fixed")).toBe(true)
  })

  it("steer() mid-run lands in the same session and is promoted by the drain", async () => {
    // First stream chunk holds the drain open; steer mid-run; both prompts end
    // up in the same session and the drain promotes the steer (two user turns).
    let call = 0
    const fetch: Fetcher = async () => {
      call += 1
      if (call === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "wait", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }) + "\n\n"))
            // keep stream open briefly so the steer lands mid-drain
            setTimeout(() => controller.enqueue(enc.encode("data: [DONE]\n\n")), 120)
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return sse(['data: ' + JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join(""))
    }
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", tools: [{ name: "wait", execute: async () => ({ waited: true }) }], fetch: fetch as never })

    const run = app.prompt("start long task", "user")
    await Bun.sleep(30)
    await app.steer("also do this extra thing")
    await run

    const history = await app.resume()
    const userTexts = history.messages.filter((m) => m.kind === "user").map((m) => (m as { text: string }).text)
    // Both the original prompt and the mid-run steer are in the same session.
    expect(userTexts).toContain("start long task")
    expect(userTexts).toContain("also do this extra thing")
  })

  it("wires the builtin toolset automatically when no tools are provided", async () => {
    // First turn: the model calls the builtin `write` tool. Second turn: stop.
    const turn1 = [
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write", arguments: '{"path":"x.txt","content":"hi"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    const turn2 = ["data: " + JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    let call = 0
    const fetch: Fetcher = async () => sse(call++ === 0 ? turn1 : turn2)
    // No explicit tools and no plugins → the builtin set must be wired, and the
    // tool must resolve + write inside the workspace (validating the sandbox).
    const dir = await mkdtemp(join(tmpdir(), "nh-builtin-"))
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", workspace: dir, fetch: fetch as never })

    const result = await app.prompt("write the file", "user")
    expect(result.finish).toBe("stop")
    expect(result.step).toBe(2)

    const history = await app.resume()
    const tool = history.messages.find((m) => m.kind === "tool")
    expect(tool).toBeDefined()
    // The builtin write actually created the file in the workspace.
    const text = await readFile(join(dir, "x.txt"), "utf8")
    expect(text).toBe("hi")
    await rm(dir, { recursive: true, force: true })
  })

  it("an explicit tools: [] overrides the toolset to zero (never the builtin baseline)", async () => {
    // M3.5 §2.3 discriminates on `!== undefined`: a provided empty array is the
    // deliberate "override = no tools" signifier, not "keep read/write/edit".
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    let sentTools: unknown
    const fetch: Fetcher = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: unknown }
      sentTools = body.tools
      return sse(payload)
    }
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", workspace: "/w", tools: [], fetch: fetch as never })
    await app.prompt("hi")
    // An explicit empty array means "no tools": the provider body omits the tools
    // array entirely (the encoder guards on `tools?.length`), so the model has no
    // fs hands. This is the override-to-zero signifier, NOT the builtin baseline.
    expect(sentTools).toBeUndefined()
  })

  it("the default (no tools key) wires the builtin baseline", async () => {
    const payload = ["data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    let sentTools: unknown
    const fetch: Fetcher = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: unknown }
      sentTools = body.tools
      return sse(payload)
    }
    const app = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", workspace: "/w", fetch: fetch as never })
    await app.prompt("hi")
    expect(Array.isArray(sentTools)).toBe(true)
    expect((sentTools as unknown[]).length).toBeGreaterThan(0)
  })

  it("discovers a pluginsDir and wires its tools additively beside builtin", async () => {
    // The model calls a plugin tool `search` AND the builtin `write` in the same
    // session — both must resolve (discovery is additive, not a replacement).
    const turn1 = [
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    const turn2 = [
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "write", arguments: '{"path":"p.txt","content":"hi"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    const turn3 = ["data: " + JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    let call = 0
    const fetch: Fetcher = async () => {
      const n = call++
      return sse(n === 0 ? turn1 : n === 1 ? turn2 : turn3)
    }

    const dir = await mkdtemp(join(tmpdir(), "nh-plugin-"))
    const ws = await mkdtemp(join(tmpdir(), "nh-plugin-ws-"))
    const { writeFile, mkdir } = await import("node:fs/promises")
    await mkdir(join(dir, "tools"), { recursive: true })
    await writeFile(join(dir, "tools", "search.json"), JSON.stringify({ name: "search", description: "search" }))

    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" },
      model: "m",
      workspace: ws,
      pluginsDir: dir,
      fetch: fetch as never,
    })

    const result = await app.prompt("run", "user")
    expect(result.finish).toBe("stop")
    expect(result.step).toBe(3)

    const history = await app.resume()
    // Plugin `search` resolved (a discovered JSON stub throws at execution — a
    // declared-but-unimplemented tool fails loudly, never silently) and builtin
    // `write` ran and created the file.
    const writeTool = history.messages.find((m) => m.kind === "tool")
    expect(writeTool).toBeDefined()
    const text = await readFile(join(ws, "p.txt"), "utf8")
    expect(text).toBe("hi")
    await rm(dir, { recursive: true, force: true })
    await rm(ws, { recursive: true, force: true })
  })

  it("resolves an explicit tool over a same-named plugin and builtin tool", async () => {
    // A plugin tool `read` plus the builtin `read` collide with an explicit tool
    // `read`. Execution must prefer the explicit one (first-wins), proving the
    // protocol surface and the tool resolver agree on precedence. Also: the model
    // must see a single resolved `read`, not three copies with conflicting types.
    const turn1 = [
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":"a.txt"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    const turn2 = ['data: ' + JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join("")
    let call = 0
    const fetch: Fetcher = async () => sse(call++ === 0 ? turn1 : turn2)

    const { PluginRegistry } = await import("@newhorse/plugin")
    const pr = new PluginRegistry()
    pr.register({ kind: "tool", name: "read", description: "plugin read", execute: async () => "PLUGIN" })

    // Explicit tool carries the highest precedence.
    const explicit = { name: "read", execute: async () => "EXPLICIT" }
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" },
      model: "m",
      workspace: await mkdtemp(join(tmpdir(), "nh-collide-")),
      tools: [explicit],
      plugins: pr,
      fetch: fetch as never,
    })

    await app.prompt("read the file", "user")
    const history = await app.resume()
    // The tool-result output is the explicit one (EXPLICIT), not plugin/builtin.
    const toolResult = history.messages.find((m) => m.kind === "tool")
    expect(toolResult).toBeDefined()
    expect((toolResult as { output: string }).output).toBe("EXPLICIT")
  })

  it("does not crash createApp when a pluginsDir contains colliding tool names", async () => {
    // Two discovered tools declare the same name in one plugin folder; convention
    // discovery must skip the duplicate (first-wins, stable) rather than throw.
    const dir = await mkdtemp(join(tmpdir(), "nh-collide-dir-"))
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(join(dir, "tools"), { recursive: true })
    await writeFile(join(dir, "tools", "a.json"), JSON.stringify({ name: "dup" }))
    await writeFile(join(dir, "tools", "b.json"), JSON.stringify({ name: "dup" }))

    const fetch: Fetcher = async () => sse(['data: ' + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n", "data: [DONE]\n\n"].join(""))
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" },
      model: "m",
      pluginsDir: dir,
      fetch: fetch as never,
    })
    // createApp succeeded (no thrown PluginError); it just discarded the dupe.
    expect(app).toBeDefined()
    await rm(dir, { recursive: true, force: true })
  })

  it("records Session.Created.location from the derived workspace (not empty)", async () => {
    // When a transport omits workspace, the id is derived from cwd and the
    // Created.location must match that same value — otherwise listSessions by
    // cwd returns 0 rows and the session collapses into workspace:"".
    const { PluginRegistry } = await import("@newhorse/plugin")
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" },
      model: "m",
      plugins: new PluginRegistry(),
      fetch: (async () => sse("data: [DONE]\n\n")) as unknown as Fetcher,
    })
    const rows = await app.listSessions()
    expect(rows.length).toBe(1)
    // The recorded location is the cwd-derived workspace (non-empty), so a
    // query by that path finds it.
    const row = rows[0]!
    expect(row.workspace.length).toBeGreaterThan(0)
  })

  it("rejects an empty sessionId at createApp", async () => {
    const { PluginRegistry } = await import("@newhorse/plugin")
    await expect(createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" },
      model: "m",
      sessionId: "",
      plugins: new PluginRegistry(),
      fetch: (async () => sse("data: [DONE]\n\n")) as unknown as Fetcher,
    })).rejects.toThrow(/sessionId/)
  })
})

describe("command consumption + memory trigger (app)", () => {
  it("runCommand resolves a registered slash command via the plugin seam", async () => {
    const { PluginRegistry } = await import("@newhorse/plugin")
    const pr = new PluginRegistry()
    pr.register({ kind: "command", name: "plan", description: "Make a plan", run: async (args) => `plan for ${args.join(",")}` })
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m",
      workspace: await mkdtemp(join(tmpdir(), "nh-cmd-")),
      plugins: pr,
      fetch: (async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })) as never,
    })
    expect(await app.runCommand("/plan fix bug")).toBe("plan for fix,bug")
    expect(await app.runCommand("/nope")).toBeUndefined()
    expect(await app.runCommand("not a command")).toBeUndefined()
  })

  it("enabled memory extraction stores a durable memory after a prompt settles", async () => {
    const { MemoryMemoryStore } = await import("@newhorse/memory")
    const store = new MemoryMemoryStore()
    // A pipe-backed extraction: the app's LLM returns a JSON atom.
    const payload = [
      "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }) + "\n\n",
      "data: [DONE]\n\n",
    ].join("")
    let call = 0
    const app = await createApp({
      provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m",
      workspace: await mkdtemp(join(tmpdir(), "nh-memapp-")),
      memoryStore: store,
      memoryExtract: { enabled: true },
      fetch: (async () => {
        call++
        // Turn 1 = the session prompt; later calls = extraction pipe.
        if (call === 1) return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })
        return new Response("data: " + JSON.stringify({ choices: [{ delta: { content: '[{"content":"user is from Shanghai","type":"fact","priority":60}]' }, finish_reason: "stop" }] }) + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
      }) as never,
    })
    await app.prompt("Hi", "user")
    // wait for the fire-and-forget extraction to land ($: extraction is async)
    let stored = false
    for (let i = 0; i < 50 && !stored; i++) {
      await new Promise((r) => setTimeout(r, 10))
      stored = (await store.search("Shanghai")).length > 0
    }
    expect(stored).toBe(true)
  })
})

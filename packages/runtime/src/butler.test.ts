import { describe, expect, it } from "bun:test"
import { MemoryEventStore, SessionRegistry } from "@newhorse/core"
import { createButlerTools } from "./butler"
import { createApp } from "./app"
import type { Initiator, ToolCtx } from "@newhorse/core"
import type { Fetcher } from "@newhorse/llm"

type AuditedEntry = { actorKind: "user" | "butler" | "parent"; actorId: string; op: string; targetSessionId?: string; outcome: "allowed" | "denied"; reason?: string }

async function setup(butlerSession = "b1"): Promise<{ tools: ReturnType<typeof createButlerTools>; registry: SessionRegistry; audits: AuditedEntry[]; events: MemoryEventStore }> {
  const events = new MemoryEventStore()
  const registry = new SessionRegistry(events)

  // seed a session s1 owned by parent p1, so parent scoping is testable.
  await events.append("s1", "Session.Created", { id: "s1", location: "/w", createdAt: 1 })
  await events.append("s1", "Session.Spawned", { sessionId: "s1", parentId: "p1" })

  const audits: AuditedEntry[] = []
  const appendAudit = async (e: AuditedEntry) => {
    audits.push(e)
  }
  const tools = createButlerTools({ registry, appendAudit })
  void butlerSession
  return { tools, registry, audits, events }
}

const butlerSession = "b1"

function ctx(caller: Initiator, hooks?: Partial<ToolCtx>): ToolCtx {
  return { caller, ...hooks }
}

describe("butler authority", () => {
  it("butler without user authorization cannot send_to_session (default deny)", async () => {
    const { tools, audits } = await setup()
    const send = tools.find((t) => t.name === "send_to_session")!
    await expect(send.execute({ target: "s1", content: "hi" }, ctx({ kind: "butler", sessionId: butlerSession }))).rejects.toThrow(/denied|butler requires explicit user authorization/)
    expect(audits.at(-1)?.outcome).toBe("denied")
  })

  it("parent can only send to its own direct child", async () => {
    const { tools, audits } = await setup()
    const send = tools.find((t) => t.name === "send_to_session")!
    // p1 is s1's parent -> allowed.
    await expect(send.execute({ target: "s1", content: "hi" }, ctx({ kind: "parent", sessionId: "p1" }))).resolves.toMatchObject({ authorization: "allowed", targetId: "s1" })
    expect(audits.at(-1)?.outcome).toBe("allowed")
  })

  it("user has highest authority for send", async () => {
    const { tools } = await setup()
    const send = tools.find((t) => t.name === "send_to_session")!
    await expect(send.execute({ target: "s1", content: "hi" }, ctx({ kind: "user" }))).resolves.toMatchObject({ authorization: "allowed" })
  })

  it("a non-child parent is denied send (unknown target scoping)", async () => {
    const { tools, audits } = await setup()
    const send = tools.find((t) => t.name === "send_to_session")!
    // p2 is NOT s1's parent -> denied.
    await expect(send.execute({ target: "s1", content: "x" }, ctx({ kind: "parent", sessionId: "p2" }))).rejects.toThrow(/denied/)
    expect(audits.at(-1)?.outcome).toBe("denied")
  })

  it("interrupt: butler wide, parent scoped to direct child", async () => {
    const { tools, audits } = await setup()
    const interrupt = tools.find((t) => t.name === "interrupt")!
    // butler can interrupt any (authorization allowed; effect pending w/o hub).
    await expect(interrupt.execute({ target: "s1" }, ctx({ kind: "butler", sessionId: butlerSession }))).resolves.toMatchObject({ authorization: "allowed" })
    // parent p1 (s1's parent) may interrupt s1.
    await expect(interrupt.execute({ target: "s1" }, ctx({ kind: "parent", sessionId: "p1" }))).resolves.toMatchObject({ authorization: "allowed" })
    // parent p2 (not s1's parent) denied.
    await expect(interrupt.execute({ target: "s1" }, ctx({ kind: "parent", sessionId: "p2" }))).rejects.toThrow(/denied/)
    expect(audits.filter((a) => a.op === "interrupt" && a.outcome === "denied").length).toBe(1)
  })

  it("audit records allowed and denied for send", async () => {
    const { tools, audits } = await setup()
    const send = tools.find((t) => t.name === "send_to_session")!
    await send.execute({ target: "s1", content: "ok" }, ctx({ kind: "parent", sessionId: "p1" })).catch(() => {})
    await send.execute({ target: "s1", content: "no" }, ctx({ kind: "butler", sessionId: butlerSession })).catch(() => {})
    expect(audits.some((a) => a.outcome === "allowed")).toBe(true)
    expect(audits.some((a) => a.outcome === "denied")).toBe(true)
  })

  it("A2: app.prompt(principal) derives the caller kind and gates butler send", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const d = await mkdtemp(join(tmpdir(), "nh-b-"))
    const sse = (payload: string): Response => new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } })

    try {
      // Seed a bare target session in the shared store so the butler resolves it.
      const seedApp = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "s1", dataDir: d, fetch: (async () => sse("data: [DONE]\n\n")) as unknown as Fetcher })
      await seedApp.resume()

      // LLM stub returns a send_to_session tool call.
      const toolPayload = [
        'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "send_to_session", arguments: JSON.stringify({ target: "s1", content: "hi" }) } }] }, finish_reason: "tool_calls" }] }) + "\n\n",
        "data: [DONE]\n\n",
      ].join("")
      const fetch: Fetcher = async () => sse(toolPayload)
      const butler = await createApp({ provider: { kind: "openai", baseUrl: "https://x", apiKey: "k" }, model: "m", sessionId: "butler", asButler: true, dataDir: d, fetch: fetch as never })

      // default (butler) principal -> send denied; should not crash.
      await butler.prompt("tell s1 hi")
      const audits = await butler.audit("butler")
      expect(audits.some((a) => a.op === "send_to_session" && a.outcome === "denied")).toBe(true)

      // user principal -> caller.kind user -> send allowed.
      await butler.prompt("tell s1 hi", "user")
      const audits2 = await butler.audit("butler")
      expect(audits2.some((a) => a.op === "send_to_session" && a.outcome === "allowed")).toBe(true)
    } finally {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("spawn_agent is audited and unknown target is denied", async () => {
    const { tools, audits } = await setup()
    const spawn = tools.find((t) => t.name === "spawn_agent")!
    const child = await spawn.execute(
      { model: "m" },
      ctx({ kind: "butler", sessionId: butlerSession }, {
        sessionId: butlerSession,
        spawnFrom: async () => "child-1",
        appendAudit: async (e) => {
          audits.push(e)
        },
      }),
    )
    const childId = (child as { childSessionId?: string }).childSessionId
    expect(childId).toBe("child-1")
    // spawn must be audited.
    expect(audits.some((a) => a.op === "spawn_agent" && a.outcome === "allowed")).toBe(true)

    // send to an unknown target -> denied (needsTarget short-circuit).
    const send = tools.find((t) => t.name === "send_to_session")!
    await expect(send.execute({ target: "ghost", content: "x" }, ctx({ kind: "parent", sessionId: "p1" }))).rejects.toThrow(/denied/)
    expect(audits.at(-1)?.outcome).toBe("denied")
  })

  it("a real spawn makes its child resolvable to the butler (no dead-index false deny)", async () => {
    const { tools, registry, events } = await setup()

    // Warm the registry index (hydrate) BEFORE the child exists, so a later
    // get of the child would hit the dead-index path if refresh() did not run.
    await registry.get("s1")

    // Persist a real child after the index was warmed (as hub.spawn does).
    const childId = "child-1"
    await events.append(childId, "Session.Created", { id: childId, location: "/c", createdAt: Date.now() })
    await events.append(childId, "Session.Spawned", { sessionId: childId, parentId: "b1" })

    const send = tools.find((t) => t.name === "send_to_session")!
    // A parent (b1) sending to its real child must be allowed — the guarded
    // helper refreshes the registry so the just-spawned child is resolvable.
    const res = await send.execute({ target: childId, content: "hi" }, ctx({ kind: "parent", sessionId: "b1" }, { registry }))
    expect((res as { authorization?: string }).authorization).toBe("allowed")
  })
})

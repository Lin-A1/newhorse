import { describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { handleChannelInbound, channelSessionId, type ChannelConfig } from "./channel"

describe("inbound channel seam", () => {
  const base: ChannelConfig = { id: "test-channel" }

  it("prompts the bound session as principal user and returns the reply", async () => {
    const prompted: Array<{ sessionId: string; text: string; principal: string }> = []
    const result = await handleChannelInbound(
      {
        config: base,
        prompt: async (sessionId, text, principal) => {
          prompted.push({ sessionId, text, principal: principal! })
          return { finish: "stop", reply: "done" }
        },
      },
      { text: "  hello channel  ", userId: "u1" },
    )
    expect(prompted.length).toBe(1)
    expect(prompted[0]!.text).toBe("hello channel") // trimmed
    expect(prompted[0]!.principal).toBe("user")
    expect(result.sessionId).toBe(channelSessionId("test-channel"))
    expect(result.finish).toBe("stop")
    expect(result.reply).toBe("done")
  })

  it("uses the explicit sessionId when configured", async () => {
    let seen = ""
    await handleChannelInbound(
      { config: { ...base, sessionId: "custom-session" }, prompt: async (sessionId) => { seen = sessionId; return { finish: "stop", reply: "" } } },
      { text: "x" },
    )
    expect(seen).toBe("custom-session")
  })

  it("signs the outbound webhook and delivers the settled reply", async () => {
    const deliveries: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    await handleChannelInbound(
      {
        config: { ...base, webhookUrl: "https://hooks.example/post", secret: "s3cret" },
        prompt: async () => ({ finish: "stop", reply: "the answer" }),
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          deliveries.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) })
          return new Response("ok")
        }) as never,
      },
      { text: "q" },
    )
    expect(deliveries.length).toBe(1)
    const body = JSON.stringify({ channelId: "test-channel", sessionId: channelSessionId("test-channel"), prompt: "q", reply: "the answer", finish: "stop" })
    expect(deliveries[0]!.body).toBe(body)
    expect(deliveries[0]!.headers["x-newhorse-signature"]).toBe("sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex"))
  })

  it("a dead webhook never corrupts the settled turn", async () => {
    const result = await handleChannelInbound(
      {
        config: { ...base, webhookUrl: "https://hooks.example/post" },
        prompt: async () => ({ finish: "stop", reply: "safe" }),
        fetchImpl: (async () => { throw new Error("connection refused") }) as never,
      },
      { text: "q" },
    )
    expect(result.reply).toBe("safe")
  })

  it("rejects disabled channels and empty text", async () => {
    expect(
      handleChannelInbound({ config: { ...base, enabled: false }, prompt: async () => ({ finish: "stop", reply: "" }) }, { text: "x" }),
    ).rejects.toThrow(/disabled/)
    expect(
      handleChannelInbound({ config: base, prompt: async () => ({ finish: "stop", reply: "" }) }, { text: "   " }),
    ).rejects.toThrow(/text is required/)
  })
})

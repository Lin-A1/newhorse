import { RpcClient, parseMessage } from "./rpc"

/**
 * MCP streamable-HTTP transport: every request is a POST carrying one JSON-RPC
 * message; the server answers either a single JSON body or an SSE stream
 * (data: frames). A `Mcp-Session-Id` response header, when present, is echoed
 * on every later call. One POST per request keeps the client stateless beyond
 * the session id — good enough for the tools-only surface we consume.
 */
export class HttpTransport {
  private rpc: RpcClient
  private sessionId: string | undefined

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> | undefined,
    private readonly fetchImpl: typeof fetch,
    timeoutMs: number,
    private readonly label: string,
  ) {
    this.rpc = new RpcClient(timeoutMs)
  }

  async start(): Promise<void> {
    await this.initialize()
  }

  private async post(body: string): Promise<Response> {
    return this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...(this.headers ?? {}),
      },
      body,
    })
  }

  /** Send one request body, read the reply from JSON or SSE frames. */
  private async send(body: string): Promise<{ settle: (raw: string) => void; done: Promise<unknown> }> {
    const res = await this.post(body)
    const sid = res.headers.get("mcp-session-id")
    if (sid) this.sessionId = sid
    if (!res.ok) throw new Error(`mcp http ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300))
    const contentType = res.headers.get("content-type") ?? ""
    if (contentType.includes("text/event-stream")) {
      // Read frames until one parses to a response for this body's id.
      let settle!: (raw: string) => void
      const done = new Promise<unknown>((resolve, reject) => {
        settle = (raw: string): void => {
          const msg = parseMessage(raw)
          if (msg?.id === undefined) return
          if (!this.rpc.settle(msg.id, msg)) return
          resolve(undefined)
        }
      })
      void this.readSse(res, settle)
      return { settle, done }
    }
    const raw = await res.text()
    return { settle: (): void => undefined, done: Promise.resolve(raw) }
  }

  private async readSse(res: Response, settle: (raw: string) => void): Promise<void> {
    const decoder = new TextDecoder()
    const reader = res.body!.getReader()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith("data:")) settle(line.slice(5).trim())
      }
    }
  }

  private async initialize(): Promise<void> {
    const { id, promise } = this.rpc.begin()
    const { done } = await this.send(this.rpc.frame(id, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "newhorse", version: "0.1.0" },
    }))
    const raw = await done
    const msg = parseMessage(typeof raw === "string" ? raw : JSON.stringify(raw))
    if (msg?.id !== undefined) this.rpc.settle(msg.id, msg)
    await this.post(this.rpc.notification("notifications/initialized")).catch(() => {})
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const { id, promise } = this.rpc.begin()
    const { done } = await this.send(this.rpc.frame(id, method, params))
    const raw = await done
    if (typeof raw === "string") {
      const msg = parseMessage(raw)
      if (msg?.id !== undefined) this.rpc.settle(msg.id, msg)
    }
    return (await promise) as T
  }

  async close(): Promise<void> {
    this.rpc.drain(`mcp server "${this.label}" is shutting down`)
  }
}

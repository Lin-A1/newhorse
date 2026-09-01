import { RpcClient, parseMessage } from "./rpc"

/**
 * MCP stdio transport: spawn the server process, speak newline-delimited
 * JSON-RPC 2.0 over its stdin/stdout. Server stderr is forwarded to our
 * stderr prefixed (it is the only debugging surface a broken server gives).
 */
export class StdioTransport {
  private rpc: RpcClient
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly env: Record<string, string> | undefined,
    timeoutMs: number,
    private readonly label: string,
  ) {
    this.rpc = new RpcClient(timeoutMs)
  }

  async start(): Promise<void> {
    this.proc = Bun.spawn([this.command, ...this.args], {
      env: { ...process.env, ...(this.env ?? {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    void this.readLoop(this.proc.stdout)
    void this.drainStderr(this.proc.stderr)
    await this.initialize()
  }

  private async readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const msg = parseMessage(line)
        if (msg?.id !== undefined) this.rpc.settle(msg.id, msg)
      }
    }
    // Stream closed: fail everything in flight so callers don't hang.
    this.rpc.drain(`mcp server "${this.label}" closed its stdout`)
  }

  private async drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true }).trimEnd()
      if (text) console.error(`[mcp:${this.label}] ${text}`)
    }
  }

  /** initialize handshake + the notifications/initialized ack (spec order). */
  private async initialize(): Promise<void> {
    const { id, promise } = this.rpc.begin()
    this.proc!.stdin.write(this.rpc.frame(id, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "newhorse", version: "0.1.0" },
    }) + "\n")
    await promise
    this.proc!.stdin.write(this.rpc.notification("notifications/initialized") + "\n")
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const { id, promise } = this.rpc.begin()
    this.proc!.stdin.write(this.rpc.frame(id, method, params) + "\n")
    return (await promise) as T
  }

  async close(): Promise<void> {
    this.rpc.drain(`mcp server "${this.label}" is shutting down`)
    if (!this.proc) return
    try {
      this.proc.stdin.end()
    } catch {
      /* already closed */
    }
    this.proc.kill()
    await this.proc.exited
  }
}

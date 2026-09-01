/**
 * JSON-RPC 2.0 request/response plumbing shared by the MCP transports: an id
 * counter, a pending-call map with timeout, and one dispatch entry point.
 * Notifications (no id) are ignored in v1 — the client never subscribes to
 * server-initiated messages.
 */
export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = "RpcError"
    this.code = code
  }
}

export class RpcClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly timeoutMs: number) {}

  /** Resolve (or fail) one pending call by wire id. Returns true when handled. */
  settle(id: number, message: { result?: unknown; error?: { code: number; message: string } }): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(id)
    if (message.error) entry.reject(new RpcError(message.error.code, message.error.message))
    else entry.resolve(message.result)
    return true
  }

  /** Register a pending call and return its wire id + a cancel hook. */
  begin(): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(-32001, `mcp request timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    return { id, promise }
  }

  /** Reject everything still in flight (transport died). */
  drain(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new RpcError(-32000, reason))
    }
    this.pending.clear()
  }

  frame(id: number, method: string, params?: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })
  }

  notification(method: string, params?: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })
  }
}

/** Parse one wire message; returns null when it is not a response payload. */
export function parseMessage(line: string): { id?: number; result?: unknown; error?: { code: number; message: string } } | null {
  try {
    const msg = JSON.parse(line) as { id?: number | string; result?: unknown; error?: { code: number; message: string } }
    if (msg.id === undefined || typeof msg.id !== "number") return null
    return { id: msg.id, result: msg.result, error: msg.error }
  } catch {
    return null
  }
}

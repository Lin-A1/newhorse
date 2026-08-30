import type { ApprovalRequest } from "@newhorse/schema"

/**
 * Interactive approval hub — the transport-side half of the client approval
 * UX. The engine's execpolicy gate calls `gate(request)` and AWAINS; the hub
 * parks the request as pending (the client UI polls `pending()`), and a
 * client decision via `resolve(id, allow)` completes the gate. A request that
 * is never answered auto-DENIES after the timeout (fail-closed, never blocks
 * a turn forever).
 */
export interface PendingApproval extends ApprovalRequest {
  readonly createdAt: number
  readonly expiresAt: number
}

export interface ApprovalHub {
  /** The engine-facing gate (createApp onApprove). */
  readonly gate: (req: ApprovalRequest) => Promise<boolean>
  /** Currently pending requests (the client polls this). */
  readonly pending: () => PendingApproval[]
  /** Resolve one pending request; false when the id is unknown/settled. */
  readonly resolve: (id: string, allow: boolean) => boolean
}

export function createApprovalHub(opts?: { timeoutMs?: number }): ApprovalHub {
  const timeoutMs = opts?.timeoutMs ?? 120_000
  const pending = new Map<string, { req: PendingApproval; resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> }>()
  return {
    gate(req) {
      return new Promise<boolean>((resolve) => {
        const entry: PendingApproval = { ...req, createdAt: Date.now(), expiresAt: Date.now() + timeoutMs }
        // Ref'd on purpose: the auto-deny MUST fire (fail-closed). Bun 1.3.x
        // unref'd timers were observed not to fire on an idle loop.
        const timer = setTimeout(() => {
          if (pending.get(req.id)) {
            pending.delete(req.id)
            resolve(false)
          }
        }, timeoutMs)
        pending.set(req.id, { req: entry, resolve, timer })
      })
    },
    pending: () => [...pending.values()].map((p) => p.req).sort((a, b) => a.createdAt - b.createdAt),
    resolve(id, allow) {
      const entry = pending.get(id)
      if (!entry) return false
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.resolve(allow)
      return true
    },
  }
}

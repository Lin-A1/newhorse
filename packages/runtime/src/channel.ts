import { createHmac } from "node:crypto"
import type { Fetcher } from "@newhorse/llm"

/**
 * Inbound channel seam (docs/agent-runtime-integrations.md §6): a channel is a
 * named pipe that turns external messages (webhook today, IM platforms later)
 * into ordinary session prompts. Channel messages ride the SAME durable
 * admission path as human prompts — no second privileged path. Outbound, the
 * settled reply is POSTed to the channel's webhook with an HMAC signature.
 */

export interface ChannelConfig {
  readonly id: string
  /** Target session; defaults to the channel's resident session
   *  (`stableSessionId("channel:" + id)`). */
  readonly sessionId?: string
  /** Outbound webhook URL (POST after the turn settles). */
  readonly webhookUrl?: string
  /** HMAC-SHA256 secret for the outbound signature header. */
  readonly secret?: string
  readonly enabled?: boolean
}

export interface ChannelInboundRequest {
  readonly text: string
  /** External author identity (informational in v1 — one channel = one session). */
  readonly userId?: string
}

export interface ChannelInboundResult {
  readonly channelId: string
  readonly sessionId: string
  readonly finish: string
  readonly reply: string
}

export interface ChannelDeps {
  readonly config: ChannelConfig
  /** Prompt the bound session through the normal admission path. */
  readonly prompt: (sessionId: string, text: string, principal?: "user" | "butler" | "parent") => Promise<{ finish: string; reply: string }>
  /** Injectable fetch for the outbound webhook (tests). */
  readonly fetchImpl?: Fetcher
}

export function channelSessionId(channelId: string): string {
  // Deterministic per-channel resident session id (same derivation family as
  // the workspace resident id — stable across restarts, no registry needed).
  return createHmac("sha256", "newhorse/channel").update(channelId).digest("hex").slice(0, 32)
}

/** Run one inbound channel message end to end: prompt → settle → webhook out. */
export async function handleChannelInbound(deps: ChannelDeps, req: ChannelInboundRequest): Promise<ChannelInboundResult> {
  const { config } = deps
  if (config.enabled === false) throw new Error(`channel "${config.id}" is disabled`)
  const text = (req.text ?? "").trim()
  if (!text) throw new Error("text is required")

  const sessionId = config.sessionId ?? channelSessionId(config.id)
  const result = await deps.prompt(sessionId, text, "user")

  if (config.webhookUrl) {
    const body = JSON.stringify({ channelId: config.id, sessionId, prompt: text, reply: result.reply, finish: result.finish })
    const signature = config.secret ? "sha256=" + createHmac("sha256", config.secret).update(body).digest("hex") : undefined
    try {
      const res = await (deps.fetchImpl ?? fetch)(config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(signature ? { "x-newhorse-signature": signature } : {}) },
        body,
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) console.error(`[channel:${config.id}] webhook responded ${res.status} — delivery NOT confirmed`)
    } catch (err) {
      // The channel is a SIDE channel: a dead webhook must never corrupt the
      // settled turn — warn and move on.
      console.error(`[channel:${config.id}] webhook delivery failed:`, err instanceof Error ? err.message : err)
    }
  }

  return { channelId: config.id, sessionId, finish: result.finish, reply: result.reply }
}

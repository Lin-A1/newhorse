import type { LLMEvent, LLMRequest, SessionMessage, ExecPolicy } from "@newhorse/schema"
import type { SessionInputStore } from "../session/input"
import type { EventStore } from "../session/store"
import { Session } from "../session/session"
import { toLlmMessages } from "../session/messages"

/**
 * Tool contract: a callable registered in the tool seam. The turn loop hands a
 * parsed tool call here and feeds the result back into history.
 */
export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface ToolResult {
  readonly id: string
  readonly name: string
  readonly output: unknown
  readonly isError?: boolean
}

export interface Tool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: Record<string, unknown>
  readonly execute: (input: unknown, ctx?: ToolCtx) => Promise<unknown>
}

/**
 * Trusted call context injected by the loop (M2b). The `caller` is derived by
 * the runtime from the running session + admission principal, never from the
 * model's tool input — so a tool sees who is really invoking it and cannot be
 * forged by the LLM. Ordinary tools ignore `ctx`; butler tools read it.
 */
export type Initiator =
  | { readonly kind: "user" }
  | { readonly kind: "butler"; readonly sessionId: string }
  | { readonly kind: "parent"; readonly sessionId: string }

export interface ToolCtx {
  readonly caller: Initiator
  /** The executing session id (the butler that is running). */
  readonly sessionId?: string
  /** Cancellation: a cooperative tool should stop and honor this signal so its
   * side effects (e.g. a bash subprocess) are terminated rather than leaking
   * past the session interrupt. A tool may ignore it for quick ops. */
  readonly signal?: AbortSignal
  /** Optional registry a privileged/butler tool uses to resolve target + audit. */
  readonly registry?: import("../session/registry").SessionRegistry
  /** Append a butler audit action to the durable audit aggregate. */
  readonly appendAudit?: (entry: { actorKind: "user" | "butler" | "parent"; actorId: string; op: string; targetSessionId?: string; outcome: "allowed" | "denied"; reason?: string }) => Promise<void>
  /** Effects injected by the session hub for the butler's privileged tools.
   * `interrupt`/`send` return { implemented } so a tool never claims an effect
   * that a stub did not actually apply (M4 SessionManager populates them). */
  readonly interruptTarget?: (sessionId: string) => Promise<{ implemented: boolean; pending?: boolean; sessionId?: string }>
  readonly sendToTarget?: (sessionId: string, content: string) => Promise<{ implemented: boolean; pending?: boolean; sessionId?: string }>
  readonly spawnFrom?: (parentId: string, model?: string) => Promise<string>
  /** M4 execpolicy: the tool-layer authorization axis. Optional here (injected);
   * loop fills a deny-all fallback so a tool never runs unaudited. */
  readonly execPolicy?: ExecPolicy
}

export interface Agent {
  readonly id: string
  readonly model: string
  readonly tools?: Tool[]
}

/**
 * A provider-agnostic LLM client. The turn loop depends on this narrow seam so
 * any adapter (OpenAI/Anthropic/...) can be swapped without changing the loop.
 */
export interface LlmClient {
  readonly id: string
  readonly stream: (request: LLMRequest, signal?: AbortSignal) => Promise<AsyncIterable<LLMEvent>>
}

export interface TurnRuntime {
  readonly events: EventStore
  readonly inbox: SessionInputStore
  readonly llm: LlmClient
}

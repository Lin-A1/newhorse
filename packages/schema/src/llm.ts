/**
 * Canonical LLM vocabulary shared across every provider.
 *
 * This is a "locked" contract: the agent turn loop and every adapter speak
 * only this vocabulary. Provider quirks live inside a protocol, never here.
 *
 * Bidirectional shape:
 *   - LLMRequest is what the runtime wants to ask a model.
 *   - LLMEvent is what the model's streaming response lowers into.
 */
export type Role = "system" | "user" | "assistant" | "tool"

export interface TextPart {
  readonly type: "text"
  readonly text: string
}

export interface ReasoningPart {
  readonly type: "reasoning"
  /**
   * Normalized reasoning text, safe for display, compaction, and cross-model
   * lowering. On a model switch this degrades to plain text.
   */
  readonly text: string
  /**
   * Opaque provider-native reasoning payload (e.g. Anthropic's `signature`
   * block, OpenAI's `reasoning_content`). It is carried verbatim so a multi-
   * step tool sequence on the SAME model can round-trip the thinking block
   * required by some providers. It is never interpreted here — it lives in the
   * protocol, not the canonical vocabulary. Omit (undefined) when the model is
   * switched, so one model's thinking format is never fed to another.
   */
  readonly payload?: Readonly<Record<string, unknown>>
}

export interface ToolCallPart {
  readonly type: "tool-call"
  readonly id: string
  readonly name: string
  /** JSON-encoded arguments as the provider emitted them. */
  readonly input: unknown
}

export interface ToolResultPart {
  readonly type: "tool-result"
  readonly id: string
  readonly name: string
  readonly output: unknown
  readonly isError?: boolean
}

export type ContentPart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart

export interface Message {
  readonly role: Role
  readonly content: ContentPart[]
  /**
   * Stable, durable message id. Tools bound to this message by `id` so a tool
   * settlement can report which assistant message produced it. Provider-local
   * call ids may repeat across turns; this id does not.
   */
  readonly id?: string
  /**
   * Provider model that produced this message. Used for model-relative
   * history lowering: when the selected continuation model differs, reasoning
   * parts degrade to plain text and provider-native metadata is omitted.
   */
  readonly model?: string
  readonly provider?: string
}

export interface ToolSpec {
  readonly name: string
  readonly description?: string
  /** JSON Schema for the tool input. */
  readonly inputSchema?: Record<string, unknown>
}

/** Token usage reported at a step boundary; feeds cost accounting and compaction. */
export interface LLMUsage {
  readonly inputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
  readonly reasoningTokens?: number
  /** Endpoint-reported cost in provider currency, when known. */
  readonly cost?: number
}

export interface LLMRequest {
  readonly model: string
  readonly messages: Message[]
  readonly tools?: ToolSpec[]
  readonly toolChoice?: "auto" | "none" | { readonly name: string }
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: string[]
  readonly system?: string
}

/**
 * Streamed events, the single vocabulary every provider lowers into.
 * Durable boundaries are value-ish (ended); deltas are live-only.
 */
export type LLMEvent =
  | { readonly type: "text.delta"; readonly text: string }
  | { readonly type: "text.ended"; readonly text: string }
  | { readonly type: "reasoning.delta"; readonly text: string }
  | { readonly type: "reasoning.ended"; readonly text: string; readonly payload?: Readonly<Record<string, unknown>> }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool-result"; readonly id: string; readonly name: string; readonly output: unknown; readonly isError?: boolean }
  | { readonly type: "step-finish"; readonly finish: "stop" | "length" | "tool" | "content-filter"; readonly usage?: LLMUsage }
  | { readonly type: "provider-error"; readonly code: string; readonly message: string; readonly retryable: boolean; readonly metadata?: Record<string, unknown> }

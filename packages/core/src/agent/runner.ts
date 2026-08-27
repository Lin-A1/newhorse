import type { LLMEvent, LLMRequest, SessionMessage } from "@newhorse/schema"
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
  readonly execute: (input: unknown) => Promise<unknown>
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
  readonly stream: (request: LLMRequest) => Promise<AsyncIterable<LLMEvent>>
}

export interface TurnRuntime {
  readonly events: EventStore
  readonly inbox: SessionInputStore
  readonly llm: LlmClient
}

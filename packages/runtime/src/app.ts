import { MemoryEventStore, MemorySessionInput, Session, SqliteEventStore, runSession, discoverWorkspaceContext, composeSystemContext, type Agent, type TurnRuntime, type Tool, type EventStore, type LoopEvent } from "@newhorse/core"
import { join } from "node:path"
import { makeLlmClient, type AdapterConfig, type Fetcher } from "@newhorse/llm"
import { PluginRegistry } from "@newhorse/plugin"

/**
 * Runtime assembly. This is the domain wiring shared by every transport
 * (CLI / web / desktop / SDK). It composes the seams into a runnable agent
 * session and exposes how the model-visible view is produced. It holds NO
 * transport concerns — no stdin/stdout, no WebSocket, no UI. A shell imports
 * `createApp`, drives `prompt`, and renders `events`/the returned history.
 */
export interface AppConfig {
  readonly provider: AdapterConfig
  readonly model: string
  readonly sessionId?: string
  readonly workspace?: string
  /** A plugin registry whose tools back the agent. Optional. */
  readonly plugins?: PluginRegistry
  /** Direct tool list override (for tests or embedding). Optional. */
  readonly tools?: readonly Tool[]
  /** Data dir to persist the event store across restarts. */
  readonly dataDir?: string
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  readonly fetch?: Fetcher
}

/** A live session event a shell may observe (streamed model output, etc.). */
export type AppEvent = LoopEvent

export interface App {
  readonly sessionId: string
  readonly events: EventStore
  /** Subscribe to live session events; returns an unsubscribe function. */
  readonly onEvent: (listener: (event: AppEvent) => void) => () => void
  /** Run one prompt through admission → turn → settlement. */
  readonly prompt: (text: string) => Promise<PromptResult>
  /** Reconstruct the current session projection from the log. */
  readonly resume: () => Promise<Session>
}

/** Structured outcome of a prompt run (a shell renders this, not a string). */
export interface PromptResult {
  readonly step: number
  readonly needsContinuation: boolean
  readonly finish: "tool" | "stop" | "length" | "content-filter"
}

export async function createApp(config: AppConfig): Promise<App> {
  const events = await createStore(config.dataDir)
  const inbox = new MemorySessionInput(events)
  await inbox.hydrate()

  const llm = makeLlmClient(config.provider, config.fetch)
  const runtime: TurnRuntime = { events, inbox, llm }

  const sessionId = config.sessionId ?? crypto.randomUUID()
  const existing = await events.read(sessionId)
  if (existing.length === 0) {
    await events.append(sessionId, "Session.Created", { id: sessionId, location: config.workspace ?? "", createdAt: Date.now() })
  }

  const tools: Tool[] = config.tools ? [...config.tools] : config.plugins?.list("tool").map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: t.execute })) ?? []
  const toolMap = new Map(tools.map((t) => [t.name, t]))

  const agent: Agent = { id: "primary", model: config.model, tools }

  // Live event fan-out. The prompt run emits streamed model/tool events through
  // a small hook so a shell can render incrementally without polling the log.
  // Each listener is isolated: a throwing/slow listener must not corrupt the
  // turn loop's settlement path.
  const listeners = new Set<(event: AppEvent) => void>()
  const emit = (event: AppEvent): void => {
    for (const l of listeners) {
      try {
        l(event)
      } catch {
        // A broken listener must never sink the run.
      }
    }
  }
  const onEvent = (listener: (event: AppEvent) => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const app: App = {
    sessionId,
    events,
    onEvent,
    async prompt(text: string): Promise<PromptResult> {
      // Ambient workspace AGENTS.md is a Context Source: discovered from the
      // session location and admitted as model-visible context BEFORE the prompt,
      // per the "model-visible ⟺ logged" rule. It is appended only once: once a
      // system message is already in the log we reuse it, so repeated prompts in
      // a session do not keep re-inserting the same context.
      const session = Session.replay(await events.read(sessionId))
      if (!session.messages.some((m) => m.kind === "system")) {
        const docs = await discoverWorkspaceContext(config.workspace ?? process.cwd())
        const system = composeSystemContext(docs)
        if (system) {
          const systemMessage = session.projectMessage({ kind: "system", id: crypto.randomUUID(), seq: 0, text: system })
          await events.append(sessionId, systemMessage.type, systemMessage.data as Record<string, unknown>)
        }
      }
      await inbox.admit({ id: crypto.randomUUID(), sessionId, prompt: text, delivery: "steer" })
      const result = await runSession(runtime, {
        agent,
        sessionId,
        resolveTool: (name) => toolMap.get(name),
        onEvent: emit,
      })
      return { step: result.step, needsContinuation: result.needsContinuation, finish: result.finish }
    },
    async resume(): Promise<Session> {
      return Session.replay(await events.read(sessionId))
    },
  }

  return app
}

async function createStore(dataDir?: string): Promise<EventStore> {
  // Long-horizon work requires durable state: when a dataDir is given we back
  // the event log with SQLite so a restart reconstructs the session + pending
  // inbox from disk (see specs §2). Without a dataDir we fall back to memory.
  if (dataDir) {
    await Bun.write(join(dataDir, ".keep"), "").catch(() => {})
    return SqliteEventStore.open(join(dataDir, "events.db"))
  }
  return new MemoryEventStore()
}

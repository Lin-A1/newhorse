import { MemoryEventStore, MemorySessionInput, Session, SqliteEventStore, runSession, discoverWorkspaceContext, composeSystemContext, type Agent, type TurnRuntime, type Tool, type EventStore } from "@newhorse/core"
import { join } from "node:path"
import { makeLlmClient, type AdapterConfig, type Fetcher } from "@newhorse/llm"
import { PluginRegistry } from "@newhorse/plugin"

/**
 * CLI application assembly. This is the ONLY transport layer wiring that builds
 * a TurnRuntime from concrete store/adapter/registry pieces. It holds no domain
 * logic — it composes the seams and hands control to the agent loop.
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

export interface App {
  readonly sessionId: string
  readonly events: EventStore
  readonly prompt: (text: string) => Promise<string>
  readonly resume: () => Promise<Session>
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

  const app: App = {
    sessionId,
    events,
    async prompt(text: string): Promise<string> {
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
      const result = await runSession(runtime, { agent, sessionId, resolveTool: (name) => toolMap.get(name) })
      return summarize(result)
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

function summarize(result: { needsContinuation: boolean; step: number }): string {
  return result.step <= 1 ? "done" : `done (${result.step} steps)`
}

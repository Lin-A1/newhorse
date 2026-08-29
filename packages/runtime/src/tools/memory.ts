import type { Tool, ToolCtx } from "@newhorse/core"
import type { MemoryStore } from "@newhorse/memory"

/**
 * Memory tools — the model-facing consumption of the MemoryStore seam.
 * A spawned/session agent can actively recall and record durable facts; the
 * store is a pluggable backend (in-memory, SQLite, future vector).
 */

/** Build the memory_search tool (recall by keyword). */
export function createMemorySearchTool(store: MemoryStore): Tool {
  return {
    name: "memory_search",
    description: "Search the durable memory store for a fact/preference/instruction by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword(s) to search for." },
        limit: { type: "number", description: "Max results (default 5)." },
      },
      required: ["query"],
    },
    execute: async (input: unknown, ctx?: ToolCtx) => {
      const { query, limit } = (input ?? {}) as { query?: string; limit?: number }
      if (!query) return { error: "query is required" }
      const isolation = { sessionId: ctx?.sessionId, agentId: ctx?.caller.kind === "parent" ? ctx.caller.sessionId : undefined }
      const hits = await store.search(query, Math.max(1, Math.min(limit ?? 5, 20)), isolation)
      return { query, count: hits.length, memories: hits.map((m: { id: string; content: string; type: string; priority: number; createdAt: number }) => ({ id: m.id, content: m.content, type: m.type, priority: m.priority, createdAt: m.createdAt })) }
    },
  }
}

/** Build the memory_write tool (record an explicit durable fact). */
export function createMemoryWriteTool(store: MemoryStore): Tool {
  return {
    name: "memory_write",
    description: "Record an explicit fact/preference/instruction into the durable memory store.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact/preference/instruction to remember." },
        type: { type: "string", enum: ["persona", "episodic", "instruction", "fact"], description: "Kind of memory (default fact)." },
        priority: { type: "number", description: "Importance 0-100 (default 50)." },
      },
      required: ["content"],
    },
    execute: async (input: unknown, ctx?: ToolCtx) => {
      const { content, type, priority } = (input ?? {}) as { content?: string; type?: "persona" | "episodic" | "instruction" | "fact"; priority?: number }
      if (!content) return { error: "content is required" }
      const rec = await store.write({
        content,
        type: type ?? "fact",
        priority: Math.max(0, Math.min(Math.floor(priority ?? 50), 100)),
        sessionId: ctx?.sessionId ?? "memory",
        agentId: ctx?.caller.kind === "parent" ? ctx.caller.sessionId : undefined,
      })
      return { stored: true, memoryId: rec.id }
    },
  }
}

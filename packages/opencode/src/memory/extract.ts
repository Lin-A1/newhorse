import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { SessionV1 } from "@newhorse/core/v1/session"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Profile } from "@/profile"
import { Memory, MemoryPolicyRejected, SensitiveMemoryRejected } from "@/memory"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLMEvent } from "@newhorse/llm"

/**
 * Post-turn memory extraction for Companion turns.
 *
 * After a Companion (continuous) session produces its final reply, this service
 * runs once in the background (never blocking the turn) and:
 *
 *   1. Fetches related existing memories (dedup reference).
 *   2. Makes a single ADD-only LLM call that returns structured memory
 *      proposals about the user, given the recent exchange + existing memories.
 *   3. Dedups, caps, and saves each proposal via Memory.Service.save with
 *      provenance "model_inferred" — the standard review-gated path that lands
 *      in the Memory Center as a `proposed` memory for human decide/accept.
 *
 * The memory:ask tool permission is intentionally bypassed here (internal
 * service call, not a model tool invocation); proposals are still human-gated
 * by the existing `proposed` status flow.
 */

const MAX_MEMORIES = 5
const MAX_CONTEXT_MESSAGES = 6
const MAX_CONTEXT_CHARS = 6000
const DEDUP_OVERLAP_THRESHOLD = 0.6

const ExtractKind = Schema.Literals(["preference", "fact", "goal", "event"])

const ExtractResult = Schema.Struct({
  memories: Schema.Array(
    Schema.Struct({
      kind: ExtractKind,
      content: Schema.String,
    }),
  ),
})
type ExtractResult = Schema.Schema.Type<typeof ExtractResult>

const decodeResult = Schema.decodeUnknownSync(ExtractResult)

export interface ExtractInput {
  sessionID: SessionID
  session: Session.Info
  profile: Profile.Runtime
  agent: Agent.Info
  model: Provider.Model
  /** Message history already loaded by the caller, ending at (and including) the current user turn. */
  messages: SessionV1.WithParts[]
  /** The user message of the current turn. */
  lastUser: SessionV1.User
  /** The just-completed final assistant reply. */
  lastAssistant: SessionV1.Assistant
}

export interface Interface {
  readonly extract: (input: ExtractInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/MemoryExtract") {}

function textOf(message: SessionV1.WithParts): string {
  return message.parts
    .filter(
      (part): part is SessionV1.TextPart =>
        part.type === "text" && !part.synthetic && !part.ignored && !!part.text.trim(),
    )
    .map((part) => part.text.trim())
    .join("\n")
}

function buildExcerpt(messages: SessionV1.WithParts[], lastUser: SessionV1.User, assistantText: string): string {
  const userIdx = messages.findIndex((m) => m.info.id === lastUser.id)
  const lines: string[] = []
  if (userIdx >= 0) {
    const start = Math.max(0, userIdx - (MAX_CONTEXT_MESSAGES - 1))
    for (const message of messages.slice(start, userIdx + 1)) {
      const text = textOf(message)
      if (text) lines.push(`${message.info.role}: ${text}`)
    }
  }
  if (assistantText) lines.push(`assistant: ${assistantText}`)
  return lines.join("\n\n").slice(0, MAX_CONTEXT_CHARS)
}

function parseJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1]! : text).trim()
  try {
    return JSON.parse(body)
  } catch {
    const start = body.indexOf("{")
    const end = body.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

/** Containment-style token overlap: detects when one memory restates most of another. */
function overlap(a: string, b: string): number {
  const tokensA = new Set(a.split(" "))
  const tokensB = new Set(b.split(" "))
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let shared = 0
  for (const token of tokensA) if (tokensB.has(token)) shared += 1
  return shared / Math.min(tokensA.size, tokensB.size)
}

function isDuplicate(content: string, existing: ReadonlyArray<string>): boolean {
  const normalized = normalize(content)
  if (normalized.length < 8) return false
  return existing.some((raw) => {
    const candidate = normalize(raw)
    if (candidate.length < 8) return false
    if (normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized)) return true
    return overlap(normalized, candidate) >= DEDUP_OVERLAP_THRESHOLD
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const llm = yield* LLM.Service
    const sessions = yield* Session.Service

    const runExtraction = Effect.fn("MemoryExtract.runExtraction")(function* (
      input: ExtractInput,
      excerpt: string,
      relatedContents: ReadonlyArray<string>,
    ) {
      const system = [
        "You are a memory extraction subsystem for a companion assistant.",
        "From the recent exchange, propose durable memories about the user worth remembering across future sessions.",
        "",
        "Rules:",
        "- ADD-ONLY: only propose NEW information. Do not restate anything already covered by EXISTING MEMORIES.",
        "- Prefer durable facts, stable preferences, goals, and notable events. Skip one-off or task-specific chatter.",
        "- Never propose sensitive content (credentials, keys, tokens, payment details, addresses, health data).",
        "- Each memory is a single concise third-person sentence about the user.",
        `- Propose at most ${MAX_MEMORIES} memories.`,
        "- Respond with JSON only, no commentary, shaped exactly like:",
        '{"memories":[{"kind":"preference","content":"The user ..."}]}',
        '- "kind" must be one of: preference, fact, goal, event.',
      ]
      const body = [
        relatedContents.length > 0
          ? `EXISTING MEMORIES (do not duplicate these):\n${relatedContents.map((item) => `- ${item}`).join("\n")}`
          : "EXISTING MEMORIES: (none)",
        "",
        "RECENT CONVERSATION:",
        excerpt,
      ].join("\n")

      const text = yield* llm
        .stream({
          agent: input.agent,
          user: input.lastUser,
          system,
          small: true,
          tools: {},
          model: input.model,
          sessionID: input.sessionID,
          retries: 1,
          messages: [{ role: "user", content: body }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
          Effect.orDie,
        )
      const parsed = parseJSON(text)
      try {
        return decodeResult(parsed)
      } catch {
        return undefined
      }
    })

    const run = Effect.fn("MemoryExtract.run")(function* (input: ExtractInput) {
      // Skip gates: Companion (continuous) scenario only, memory must be
      // enabled, and never from forked sub-sessions (the main turn already
      // proposes; a fork would just duplicate proposals).
      if (input.profile.kind !== "companion") return
      if (input.profile.memory === "off") return
      if (input.session.parentID) return

      // The user's own words (non-synthetic parts) must exist — proactive
      // triggers and synthetic turns carry no user content to extract from.
      const userMsg = input.messages.find((m) => m.info.id === input.lastUser.id)
      const userWords = userMsg ? textOf(userMsg) : ""
      if (!userWords.trim()) return

      // The just-finished assistant reply is not in the caller's loaded
      // history, so fetch the latest message and use it only if it is ours.
      const latest = (yield* sessions.messages({ sessionID: input.sessionID, limit: 1 }))[0]
      const assistantText =
        latest && latest.info.id === input.lastAssistant.id ? textOf(latest) : ""

      const excerpt = buildExcerpt(input.messages, input.lastUser, assistantText)
      if (!excerpt.trim()) return

      // (a) Related existing memories as the dedup reference.
      const query = excerpt.slice(0, 500)
      const related = yield* memory.search({
        query,
        profileID: input.profile.id,
        relationshipOnly: true,
        status: ["active", "proposed"],
        limit: 10,
        userRuleset: input.session.permission,
      })
      const relatedContents = related.map((item) => item.content)

      // (b) Single ADD-only LLM call for candidate proposals.
      const result = yield* runExtraction(input, excerpt, relatedContents).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("memory extract LLM call failed", {
            "session.id": input.sessionID,
            error: Cause.squash(cause),
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!result || result.memories.length === 0) return

      // (c) Dedup + cap, then save each as a model_inferred proposal.
      const candidates = result.memories
        .map((item) => ({ content: item.content.trim() }))
        .filter((item) => item.content.length > 0 && !isDuplicate(item.content, relatedContents))
        .slice(0, MAX_MEMORIES)
      if (candidates.length === 0) return

      yield* Effect.logInfo("memory extract proposing", { "session.id": input.sessionID, count: candidates.length })
      yield* Effect.forEach(
        candidates,
        Effect.fnUntraced(function* (item) {
          yield* memory
            .save({
              content: item.content,
              // Companion memory lives in the relationship store so it is
              // re-surfaced in the Companion's relationship-memory context.
              kind: "relationship",
              provenance: "model_inferred",
              profileID: input.profile.id,
              sourceSessionID: input.sessionID,
              sourceMessageID: input.lastAssistant.id,
              userRuleset: input.session.permission,
            })
            .pipe(
              Effect.catchTags({
                SensitiveMemoryRejected: () =>
                  Effect.logWarning("memory extract skipped sensitive proposal", { "session.id": input.sessionID }),
                MemoryPolicyRejected: (error) =>
                  Effect.logWarning("memory extract skipped policy-rejected proposal", {
                    "session.id": input.sessionID,
                    reason: error.reason,
                  }),
              }),
              Effect.catchCause((cause) =>
                Effect.logError("memory extract save failed", {
                  "session.id": input.sessionID,
                  error: Cause.squash(cause),
                }),
              ),
            )
        }),
        { concurrency: 1 },
      )
    })

    const extract = Effect.fn("MemoryExtract.extract")(function* (input: ExtractInput) {
      yield* run(input).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("memory extract failed", { "session.id": input.sessionID, error: Cause.squash(cause) }),
        ),
      )
    })

    return Service.of({ extract })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Memory.node, LLM.node, Session.node],
})

export * as MemoryExtract from "./extract"

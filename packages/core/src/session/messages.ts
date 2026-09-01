import type { ContentPart, Message, SessionMessage } from "@newhorse/schema"

/**
 * Convert projected session messages into the canonical LLM message vocabulary.
 *
 * This is the single seam between the session log (what the model saw) and the
 * provider-agnostic `LLMRequest` (what the provider will be asked). It must
 * preserve tool-call/tool-result pairing so the protocol encoders can rebuild
 * provider-native shapes (OpenAI `tool_call_id`, Anthropic `tool_result`
 * following `tool_use`).
 *
 * `selectedModel` implements model-relative history lowering: when the message
 * was produced by a different model than the one now running, reasoning parts
 * degrade to plain text and provider-native reasoning payload is dropped.
 * Without this, one model's thinking format gets fed to another (a common
 * cross-model failure).
 */
export function toLlmMessages(
  projected: readonly SessionMessage[],
  selectedModel: string,
  /** Pre-hydrated attachment images keyed by user-message id (see
   *  resolveAttachmentImages). Absent → content-addressed refs are skipped. */
  attachmentImages?: ReadonlyMap<string, readonly import("@newhorse/schema").ImageAttachment[]>,
): Message[] {
  const out: Message[] = []
  // Images ride only the LAST user turn: they are transient visual context,
  // not durable history (the log keeps them so the client can still render
  // them). Without this aging-out, every later request re-uploads every past
  // image until the provider's request-size ceiling rejects the conversation.
  const lastUserIndex = projected.reduce((acc, m, i) => (m.kind === "user" ? i : acc), -1)

  for (let i = 0; i < projected.length; i++) {
    const m = projected[i]!
    const loweredAs = m.kind === "assistant" && !!m.model && m.model !== selectedModel

    switch (m.kind) {
      case "user": {
        // An image-only prompt has empty text: an empty text block is a
        // provider 400 (Anthropic rejects it), so it is emitted only when set.
        // Images come from the legacy inline shape OR the pre-hydrated
        // attachment map (refs ride only the last user turn — same aging rule).
        const hydrated: Array<{ type: "image"; mime: string; data: string }> = (m.images ?? []).map((img) => ({ type: "image" as const, mime: img.mime, data: img.data }))
        if (i === lastUserIndex) {
          for (const img of attachmentImages?.get(m.id) ?? []) hydrated.push({ type: "image", mime: img.mime, data: img.data })
        }
        out.push({
          role: "user",
          id: m.id,
          content: [
            ...(m.text ? [{ type: "text", text: m.text } as ContentPart] : []),
            ...hydrated,
          ],
        })
        break
      }

      case "system": {
        // System context (e.g. ambient AGENTS.md) stays a system-role message so
        // it is sent as a proper system prompt, not folded into user history.
        out.push({ role: "system", id: m.id, content: [{ type: "text", text: m.text }] })
        break
      }

      case "compaction":
      case "memory":
        // A memory record is model-visible fact text (like a compaction
        // summary) — surfaced as a user message so the model sees what was
        // recalled/stored, without pretending it wrote it.
        out.push({ role: "user", id: m.id, content: [{ type: "text", text: m.text }] })
        break

      case "assistant": {
        const content = lowerParts(m.content, loweredAs)
        out.push({ role: "assistant", id: m.id, content, model: m.model, provider: m.provider })
        break
      }

      case "tool": {
        // Each tool-result row becomes its own canonical `tool` message keyed by
        // callId. OpenAI requires one tool message per tool_call_id; the
        // Anthropic encoder is responsible for folding a run of adjacent tool
        // messages into a single user message (Anthropic's requirement). Keeping
        // them separate here is the provider-neutral shape.
        out.push({ role: "tool", id: m.id, content: [{ type: "tool-result", id: m.callId, name: m.name, output: m.output, isError: m.isError }] })
        break
      }
    }
  }

  return out
}

function lowerParts(content: ContentPart[], lowered: boolean): ContentPart[] {
  if (!lowered) return content
  // On a model switch, provider-native reasoning payload is dropped and the
  // reasoning text degrades to an ordinary text part.
  return content.map((p): ContentPart => (p.type === "reasoning" && p.payload ? { type: "reasoning", text: p.text } : p))
}

/**
 * Pre-hydrate content-addressed attachment refs for the LAST user message into
 * inline image attachments (keyed by message id), ready for toLlmMessages.
 * Missing store objects resolve to nothing — a ref whose bytes are gone lowers
 * as text-only rather than failing the turn (the store is append-only, so this
 * is a should-never-happen guard, not a license to GC).
 */
export async function resolveAttachmentImages(
  projected: readonly SessionMessage[],
  attachments?: { readonly get: (sha256: string) => Promise<{ mime: string; bytes: Uint8Array } | null> },
): Promise<ReadonlyMap<string, readonly import("@newhorse/schema").ImageAttachment[]>> {
  if (!attachments) return new Map()
  const lastUserIndex = projected.reduce((acc, m, i) => (m.kind === "user" ? i : acc), -1)
  const m = projected[lastUserIndex]
  if (!m || m.kind !== "user" || !m.attachments?.length) return new Map()
  const images: import("@newhorse/schema").ImageAttachment[] = []
  for (const ref of m.attachments) {
    const stored = await attachments.get(ref.sha256)
    if (stored) images.push({ mime: ref.mime, data: Buffer.from(stored.bytes).toString("base64") })
  }
  return new Map([[m.id, images]])
}

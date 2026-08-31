import type { StoredEvent, SessionEvent, SessionMessage, SessionSnapshot, UnknownRecord } from "@newhorse/schema"

/**
 * Session aggregate, reconstructed by folding its durable events.
 *
 * This is "model-visible ⟺ logged" made concrete: the model's view is derived
 * from the log by folding events, never from a live memory copy the caller
 * mutates first. Message projection is a pure function producing events; the
 * caller persists them, then the snapshot is re-derived from the persisted log.
 */
export class Session {
  readonly #id: string
  readonly #location: string
  readonly #projectId: string | undefined
  readonly #createdAt: number
  #messages: SessionMessage[] = []
  #headSeq = -1
  #step = 0
  #interrupted = false
  /** Images from PromptAdmitted, resolved when their prompt is promoted —
   *  the base64 is stored once (on the admit event), never duplicated. */
  #admittedImages = new Map<string, readonly { mime: string; data: string }[]>()

  private constructor(id: string, location: string, projectId: string | undefined, createdAt: number) {
    this.#id = id
    this.#location = location
    this.#projectId = projectId
    this.#createdAt = createdAt
  }

  static create(id: string, location: string, projectId?: string): Session {
    return new Session(id, location, projectId, Date.now())
  }

  /**
   * Rebuild a session by folding its stored events in order. Folds every event
   * kind so step count / interrupted state / headSeq are reconstructed, not just
   * messages. Throws when the stream lacks a Session.Created event.
   */
  static replay(events: StoredEvent[]): Session {
    const created = events.find((e) => e.type === "Session.Created")
    if (!created) throw new SessionError("cannot replay a session without a Session.Created event")
    const c = (created.data ?? {}) as { id?: string; location?: string; projectId?: string; createdAt?: number }
    const session = new Session(c.id ?? "unknown", c.location ?? "", c.projectId, c.createdAt ?? Date.now())

    for (const event of events) {
      session.#fold(event)
    }
    return session
  }

  #fold(event: StoredEvent): void {
    this.#headSeq = event.seq
    switch (event.type) {
      case "Session.Created":
        break
      case "Session.PromptAdmitted": {
        const a = event.data as { id?: string; images?: { mime: string; data: string }[] }
        if (a.id && a.images?.length) this.#admittedImages.set(a.id, a.images)
        break
      }
      case "Session.MessageAppended": {
        const data = event.data as { message?: SessionMessage }
        if (data.message) this.#messages.push({ ...data.message, seq: event.seq })
        break
      }
      case "Session.Prompted": {
        // A promoted admission becomes a visible user message. Its durable seq
        // is the Prompted event's OWN seq (the position in the log where the
        // promotion happened), not the earlier admission seq — otherwise a
        // steer promoted mid-turn would project a seq lower than a prior
        // assistant message, breaking monotonicity for any consumer filtering
        // by seq. Attachments ride the same event (model-visible ⟺ logged).
        const data = event.data as { id?: string; prompt?: string; images?: { mime: string; data: string }[] }
        if (data.id && typeof data.prompt === "string") {
          // own data first (legacy logs carried images here), else resolve
          // from the durable admit event.
          const images = data.images?.length ? data.images : this.#admittedImages.get(data.id)
          this.#messages.push({ kind: "user", id: data.id, seq: event.seq, text: data.prompt, ...(images?.length ? { images } : {}) })
        }
        break
      }
      case "Session.StepEnded":
        this.#step = (event.data as { step?: number }).step ?? this.#step
        break
      case "Session.Interrupted":
        this.#interrupted = true
        break
      default:
        // ToolSettled, PromptAdmitted, Prompted, etc. do not change visible
        // projection here; they are observed live by subscribers.
        break
    }
  }

  /**
   * Pure projection: returns the MessageAppended event WITHOUT mutating state.
   * The caller persists the event to the store, then re-derives the snapshot
   * from the persisted log. This is the single write path that keeps "model-
   * visible ⟺ logged". The incoming `seq` is ignored and replaced by the next
   * durable sequence derived from the log.
   */
  projectMessage(message: SessionMessage): SessionEvent {
    return { type: "Session.MessageAppended", data: { sessionId: this.#id, message: { ...message, seq: this.#headSeq + 1 } } }
  }

  markStepEnded(step: number): SessionEvent {
    this.#step = step
    return { type: "Session.StepEnded", data: { sessionId: this.#id, step, finish: "stop" } }
  }

  markInterrupted(): SessionEvent {
    this.#interrupted = true
    return { type: "Session.Interrupted", data: { sessionId: this.#id } }
  }

  get id(): string {
    return this.#id
  }

  get location(): string {
    return this.#location
  }

  get projectId(): string | undefined {
    return this.#projectId
  }

  get createdAt(): number {
    return this.#createdAt
  }

  get messages(): readonly SessionMessage[] {
    return this.#messages
  }

  get headSeq(): number {
    return this.#headSeq
  }

  get step(): number {
    return this.#step
  }

  get interrupted(): boolean {
    return this.#interrupted
  }

  snapshot(): SessionSnapshot {
    return { id: this.#id, location: this.#location, projectId: this.#projectId, createdAt: this.#createdAt, messages: [...this.#messages], headSeq: this.#headSeq }
  }
}

export class SessionError extends Error {
  readonly _tag = "SessionError"
  constructor(message: string) {
    super(message)
    this.name = "SessionError"
  }
}

/** Type-checked projection: validate a SessionMessage by kind. */
export function asSessionMessage(value: unknown): SessionMessage | undefined {
  const v = value as Partial<SessionMessage>
  if (typeof v?.kind !== "string" || typeof v?.id !== "string" || typeof v?.seq !== "number") return undefined
  switch (v.kind) {
    case "user":
      return typeof (v as { text?: unknown }).text === "string" ? (v as SessionMessage) : undefined
    case "assistant":
      return Array.isArray((v as { content?: unknown }).content) ? (v as SessionMessage) : undefined
    case "tool":
      return typeof (v as { callId?: unknown }).callId === "string" && typeof (v as { name?: unknown }).name === "string" ? (v as SessionMessage) : undefined
    case "system":
    case "compaction":
      return typeof (v as { text?: unknown }).text === "string" ? (v as SessionMessage) : undefined
    case "memory":
      return typeof (v as { text?: unknown }).text === "string" ? (v as SessionMessage) : undefined
    default:
      return undefined
  }
}

export type { UnknownRecord }

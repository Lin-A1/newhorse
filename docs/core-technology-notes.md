# Newhorse v2 Core Technology Design Notes

> Implemented/decision design for the v2 runtime. `specs/v2/` holds the plan; this file captures what we actually built and why. Keep current when a design materially changes.

## 1. The canonical LLM vocabulary (schema)

The runtime speaks one vocabulary end-to-end. Every provider maps into and out of it; provider quirks never leak into the loop.

- `LLMRequest` — what the runtime asks a model: `model`, `messages: Message[]`, `tools`, `toolChoice`, temperature/maxTokens, system.
- `LLMEvent` — what a model's stream lowers into: `text.delta/ended`, `reasoning.delta/ended`, `tool-call`, `tool-result`, `step-finish` (with `usage`), `provider-error`.
- `Message` — a canonical turn: `role`, `content: ContentPart[]`, an optional stable `id`, and the producing `model`/`provider`.

Why a single vocabulary: it is the seam between the agent loop and any provider. Loops never branch on `openai` vs `anthropic`; they consume `LLMEvent` and emit `LLMRequest`. Provider differences live in the protocol only.

**Locked contract**: changing the vocabulary is expensive (every adapter + the loop would rework). It is frozen in M1.

## 2. Four-axis Route (llm)

A Route composes four independent axes so deployment and protocol are decoupled:

| Axis | Responsibility |
|---|---|
| `Protocol` | encode `LLMRequest` → provider wire body; decode provider stream → `LLMEvent[]` |
| `Endpoint` | base URL + path; `resolve()` |
| `Auth` | header/value + optional extra headers (e.g. `anthropic-version`) |
| `Framing` | `sse` or `json` |

The key axis is `Protocol` (`encode`/`init`/`step`). It is the *only* thing that differs across providers. Because `Route` is composed from independent axes, a provider family that shares a wire shape (OpenAI, DeepSeek, Together, Cerebras) reuses one `Protocol` and just swaps endpoint + auth.

- `makeRoute(parts)` is the public way to reassemble arbitrary axes (e.g. reuse `openaiProtocol` with a different endpoint + signature auth).
- `makeLlmClient(config)` is a convenience factory over a `kind`.

**Currently implemented Protocols**:
- `openai` — Chat Completions (`/v1/chat/completions`), reused by openai-compatible hosts.
- `openai-responses` — OpenAI Responses API (`/v1/responses`, the current recommended interface, used by Codex). A separate protocol that fits the same four-axis shape; the agent loop is untouched.
- `anthropic` — Messages (`/v1/messages`), with thinking/signature round-trip.

A `ProviderKind` (`openai` | `openai-responses` | `anthropic` | `openai-compatible`) picks the protocol + endpoint + auth via a `PROVIDERS` lookup table (not scattered if/switch); `makeLlmClient` is the convenience factory. Because a Protocol is an independent axis, adding a new wire shape never touches the turn loop.

Responses-specific notes: tool calls/results are **top-level** `input` items (`function_call` / `function_call_output`), not nested in message content; `tool_choice` for a named function is `{type:"function", name}`; a `response.completed` with `status:"incomplete"` is reported as `finish:"length"`; a stream-resident `response.failed`/`error` maps to `provider-error` with retryability derived from the code (`rate_limit_exceeded`/`server_error`/... are retryable). Tool-call `arguments` are JSON strings that the loop normalizes to objects at a single boundary.

## 3. Event-sourced session (session)

Every durable fact about a session is an append-only log of `(aggregate_id, seq, type, data)`. The log is the source of truth; the model-visible view is a *projection*.

- `EventStore` is a replaceable backend (`MemoryEventStore`, `SqliteEventStore`). SQLite allocates `seq` from a dedicated `event_sequence` table so concurrent appends cannot collide.
- `Session.replay(events)` folds the whole log into messages + headSeq + step + interrupted state. It never trusts an in-memory mutable copy as the truth — it derives everything from the log.
- **"model-visible ⟺ logged"**: anything the model sees must already be in the log. Turn output, tool results, interrupted tools, even the ambient AGENTS.md system context, are appended before they become visible.

## 4. Durable admission inbox (session)

Prompts are admitted to a durable `session_input` cell *before* becoming model-visible.

- Idempotent `admit`: same id + same content returns the same receipt; same id + different content is a conflict (throws).
- Delivery semantics: `steer` (promote at the next safe boundary) vs `queue` (drain one at a time when otherwise idle).
- `hydrate()` rebuilds pending rows from the log on startup, so pending prompts survive a restart.

## 5. Seam container (core)

A minimal Cordis-style three-part seam, self-implemented (we adopt Cordis *semantics*, not its kernel):

- **Service Definition** — a `defineService(name)` producing a stable, memoized `ServiceID`.
- **Provider** — `container.register(def, value, cleanup?)` returns a disposer.
- **Consumer** — `consumer(dependsOn)` + `inject(container)`.

Key properties:
- Register-as-disposer, revocable; duplicate registration throws.
- `container.dispose()` tears down in reverse registration order (children before parents) and **cascades to live children**, so a child never keeps resolving against a torn-down parent.
- `scope()` creates a child inheriting the parent's providers for lookup, able to shadow them, with `dispose()` that only affects its own registrations — the isolation primitive for per-Location / per-DAG-node injection. A disposed container refuses further `register`/`get` with a clear error (no silent misuse).

We deliberately do **not** pull in the full `@cordis` kernel: the value of a full DI kernel is ecosystem reuse (running someone else's Koishi/DSH plugins), which we do not need. We keep the seam contract and drop the heavy runtime.

## 6. Agent turn loop (agent)

- `runSession` drains a session: promote eligible input, assemble `LLMRequest`, `runTurn`, decide whether to continue.
- `runTurn` makes one `llm.stream`, builds the assistant message (text / reasoning / tool-calls) and appends it, executes each tool call, appends the tool result, and emits a `Step.Ended`. It continues when a tool call was present (decoupled from the `finish` reason, since a provider may emit tool calls alongside a `stop`/`length` finish).
- **Interrupted tool recovery**: on replay, an assistant message with a tool call but no paired result is failed as `Tool execution interrupted` rather than silently replayed or fed to the model as a malformed request.
- Model-relative lowering happens in `toLlmMessages`: when the continuation model differs from the producing model, reasoning degrades to plain text and the opaque provider reasoning payload is dropped (so one model's thinking format is never fed to another).

## 7. Plugin registration surface (plugin)

Five capability kinds register through one seam — `tool` / `agent` / `command` / `hook` / `provider` — so consumers pull from the registry rather than branching on types inline.

- `PluginRegistry` stores capabilities by kind + name; `register` returns a disposer; `registerAll`/`dispose` enable bulk unload; a `provider` capability can register into a `Container` and have its disposer composed into the plugin's own.
- Directory-as-registration-surface: `discoverPlugin` reads `agents/`, `commands/`, `hooks/`, `tools/` by convention; `hooks.json` events are whitelisted (`HOOK_EVENTS`) so unknown events are skipped rather than silently registered.

## 8. Workspace context (core/agent/context)

Ambient `AGENTS.md` is a Context Source. `discoverWorkspaceContext` walks upward from the session location (contained within a root), realpath-normalizing for containment; `composeSystemContext` orders deepest-first. It is admitted as a System-role context message once per session (reused, not re-appended per prompt).

## 9. Runtime assembly + transport layering (runtime)

`createApp` lives in `packages/runtime` and is the **domain assembly** shared by every transport. It composes the seams (store + inbox + llm + agent + tools), injects the ambient system context, and drives `runSession`. It holds no transport concerns.

- `App` exposes `sessionId`, `events` (the EventStore), `onEvent(listener)` (live streamed model/tool events for incremental rendering), `prompt(text)` → `PromptResult`, and `resume()`.
- `PromptResult` is structured (`step`, `needsContinuation`, `finish`); a shell renders it (e.g. `done (N steps)`) rather than a bare string, so the long-horizon `needsContinuation` signal is preserved.
- `AppEvent` is aliased to `LoopEvent` (single source from core) — `text`/`reasoning`/`tool`/`tool-result`/`step`/`error`/`done` — so the corpus stays consistent and there's no duplicated live vocabulary.
- The turn loop normalizes every provider-encoded tool `input` (a JSON string) into a JS object at a single boundary, so a tool's `execute` always receives an object regardless of protocol — no defensive parsing in tools.
- Transports are thin: `cli`/`web`/`desktop`/`sdk` only read input, render output, and call `createApp`. They do not own any domain logic.
- `runSession`/`runTurn` accept an optional `onEvent` sink so a shell can render streamed events without polling the log. Each listener is isolated with a try/catch so a broken listener cannot corrupt the settlement path.

Dependency direction: `cli` depends on `runtime` (and `schema`/`llm` for its own transport types), not on `core`/`plugin` directly. `runtime` depends on `core`/`llm`/`plugin`/`schema`. `core` never imports upper layers.

Known follow-ups (outside M1): a `runId` associating events with a specific `prompt()` call for re-used apps; a shared `resolveProvider` per shell; wiring `createApp` through the seam `Container` for provider injection.

## Usage

Design docs live in `docs/`. Plans live in `specs/v2/`. When a core mechanism is implemented, record the decision here; when a design materially changes, update this file.

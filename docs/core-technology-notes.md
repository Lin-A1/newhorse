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

## 10. Session registry + cancel (M2a)

- `SessionRegistry` (core) is a **derived read model** of the event log: single-writer event log + materialized projection. It lazily queries the EventStore (`aggregateIds()` + `read()` + fold) into an in-memory index — it does **not** hook the store's append path, does not broadcast, and does not write its own durable table in M2a (small single-process scale).
- `list`/`get`/`refresh` are observational: they return projections and never mutate a session. `refresh()` rebuilds the index so late events (e.g. an interrupt appended after hydration) are visible — avoiding a dead index.
- It gives a future butler (M2b) the list/locate/parent-chain surface for auditing send/spawn.
- **Cancel**: `runSession`/`runTurn` accept an `AbortSignal`. The drain stops between steps and **mid-stream** (the LLM transport races a blocked `reader.read()` against the signal). A cancelled run appends `Session.Interrupted` and settles with `finish:"interrupted"` (not `"stop"`).
- **Per-run controller**: each `prompt()` creates its own `AbortController`, so `interrupt()` cancels only the current run and cannot poison a later prompt (an `AbortSignal` is not resettable).

Known follow-ups (outside M1): a `runId` associating events with a specific `prompt()` call for re-used apps; a shared `resolveProvider` per shell; wiring `createApp` through the seam `Container` for provider injection.

## 11. Butler authority model (M2b)

The butler is a privileged LLM session with extra tools. Its agency must be bound by a trust boundary before any code is trusted (see `specs/v2/m2b-butler-authority.md`).

- `Initiator` is **runtime-injected** into `ToolCtx` by the loop, never self-reported by the model: `butler`/`parent` from the running session, `user` only from a transport-level principal on the prompt. A model cannot forge `{kind:"user"}`.
- **user authority** comes from `app.prompt(text, principal)` where the transport stamps a prompt (human TTY) as `user`; the derived caller kind gates butler tools for that one round. It is one-shot, never inferred from prompt text.
- Butler tools (`list_sessions`/`interrupt`/`spawn_agent`/`send_to_session`) enforce their own `authorize` gate reading `ctx.caller` + registry, and append an audit entry (`Session.ButlerAction`) to a **separate audit aggregate** (`audit:<sessionId>`) for both allowed and denied.
- Authorization rules: `list` any; `interrupt` butler-wide/parent-scoped; `spawn` any (spawner is the parent, persists `Session.Created` + `Session.Spawned`); `send_to_session` **default-deny** (user, or parent to its direct child).
- `targetRequired` tools short-circuit an unknown/missing target to denied **before** authorize.
- Audits record `actorKind` (authority source) and `actorId` (executing session) separately.
- **Scope**: M2b is single-process single-app (a session tree). Cross-app/proc parent chains and a full `SessionManager` for cross-session effect delivery (interrupt/send of another live session) are M4. The hub provides a seam; spawn persists, interrupt/send are no-op stubs until the manager exists.

## 12. Declarative DAG scheduling (M3)

A node is one subagent delegation; edges are declared deps; execution is ready-queue + event wakeup with no join blocking; each node picks its own model (cost balance). The graph is drawn forward and is the execution spec, not a background-task list or a post-hoc lineage (see `specs/v2/m3-dag-scheduling.md`).

- **Load-bearing pillars** (what makes it "declarative", not a re-skin):
  1. `DAGRun` is an event-sourced aggregate — `DAG.Declared`/`NodeStarted`/`NodeResolved`/`NodeFailed`/`NodeSkipped`/`NodeAborted`/`NodeRetried`/`Aborted` folded by `foldDAG`; a `replayDag(events, dagId)` entry rebuilds the whole graph from the log, reconciling any node still `running` (process died mid-node) to `aborted`.
  2. A runtime-enforced data contract: each node `produces` a slot (`produces ?? id`), `validate()` rejects a node whose `consumes` references a slot no ancestor produces, and `buildInput` fails on a missing slot (never silently empty).
- **Concurrency**: `validate` first (edge de-dup, cycle/unknown/self dep detection); event-driven worker pool via `pump()` (a settled node re-pumps, never a serial or per-layer `Promise.all` join); per-node `AbortController`; per-node subagent session isolation (each node is its own `runSession` with its own id/agent/model — **not** a runtime DI scope).
- **Failure/termination**: state machine includes `aborted`; `abortGraph` stops claiming new nodes, aborts in-flight, and marks running nodes `NodeAborted` / pending `NodeSkipped` (deduped via `emitAbort`); scheme-B cascade turns a dep-on-`non-succeeded` node into `skipped` without spawning it (persisted via `pendingSkips`, flushed before return).
- **Honest scope**: cross-session effect delivery and a full `SessionManager` stay M4; DAG events use `aggregate:"dag"`.

## 13. Builtin toolset — the agent's hands (M3.5)

Gives DAG nodes and sessions concrete tools to act, so cost-down (cheap model runs a subagent) is meaningful. Six tools: `read` / `write` / `edit` / `list` / `search` / `bash`, all implementing the existing `Tool` contract (`execute(input, ctx)`), so no core changes to the seam.

- **Workspace sandbox**: every fs tool resolves user paths through a single shared `resolveInWorkspace(root, p)` in `packages/runtime/src/tools/path.ts` — normalization (`path.resolve`), then `realpath` of the deepest existing ancestor (so a workspace-internal symlink/junction pointing outward cannot pass a lexical prefix check, and write targets that don't exist yet still resolve), then a containment check that is a boundary + win32 case-fold (`p === root || p.startsWith(root + sep)`, drive letters folded) so `G:\repo` is not a prefix of `G:\repo-evil`. No per-tool path checks (path-level "no scattered branches"). TOCTOU residual risk is accepted and documented.
- **Symlink escape is closed twice**: `read`/`write`/`edit` go through `resolveInWorkspace` (realpath → reject); `list`/`search` walk via `collectFiles`, which uses `lstat` and **skips** any symbolic link so a link inside the workspace is never followed into (or enumerated from) outside. This was a real bug found in review and is regression-locked by tests.
- **Bash is outside the sandbox**: it is not constrained by the fs sandbox — enabling it authorizes the session to read/write/execute any reachable path with the process user's permissions. This boundary is explicit, not implied by fs-tool sandboxing. Off by default (`enableBash`); explicit opt-in. Non-zero `exitCode` is data (the model self-corrects), not an error; `cwd` pinned to the workspace; model-supplied `timeoutMs` clamped to a 60s cap (default = cap, so a missing value is never a 1ms kill-all); Windows kill uses `taskkill /T /F` so a `cmd /c` grandchildren tree is torn down.
- **Tool semantics**: `edit` rejects `old === new` and empty `old`; empty `new` is a legal deletion; EOL is normalized for comparison but the file's original EOL is restored on write; a multi-hit returns a structured payload (count + line numbers + context) so the model can widen `old`. `read` returns line-numbered output (the cheapest self-correction lever). Errors are returned as data, not thrown (so the model sees and self-corrects); `.git`/`node_modules`/binary are excluded from traversal. Refinements found in a granularity review: `search` never produces a false "no match" — a byte budget stops the walk and reports `budgetExceeded: true` rather than silently dropping later files; `list`/`search` globs are case-folded on win32 (Bun.Glob's `caseInsensitive` does not apply to literal extensions, so we fold the pattern + target) so they agree with read/write casing semantics; `read` flags `offsetBeyond` instead of a silent empty result.
- **Wiring**: `createBuiltinTools({ workspace, enableBash })` in `packages/runtime/src/tools/index.ts`. `AppConfig` priority is explicit `tools` (empty array = deliberate none) > plugins > builtin; `Workdir` is injected into system context so the first-turn model knows the root; `DagDeps.tools` defaults to the builtin set so DAG nodes keep their hands. `ToolCtx` gained `signal?: AbortSignal` (a small core change) so a long-running bash subprocess can honor a session interrupt rather than leaking past it.
- **Honest scope**: no web fetch, no image read (multimodal fast-follow), no memory tool (M4); fine-grained permissions (execpolicy 自举) stay M4.

## Usage

Design docs live in `docs/`. Plans live in `specs/v2/`. When a core mechanism is implemented, record the decision here; when a design materially changes, update this file.

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

- `EventStore` is a replaceable backend (`MemoryEventStore`, `SqliteEventStore`). SQLite allocates `seq` via a single atomic `INSERT ... ON CONFLICT(aggregate_id) DO UPDATE SET seq = seq + 1 RETURNING seq` on a dedicated `event_sequence` table, so **concurrent/cross-process appends cannot collide** (an earlier SELECT-then-UPSERT was TOCTOU and could assign the same seq twice). The `aggregate` discriminator is **persisted as a column** (not hardcoded `"session"` on read), so `audit:`/`dag` aggregates survive a restart.
- `Session.replay(events)` folds the whole log into messages + headSeq + step + interrupted state. It never trusts an in-memory mutable copy as the truth — it derives everything from the log. A promoted `Session.Prompted` message uses the event's **own** seq (the promotion position), not the earlier admission seq, so message seq stays monotonic when a steer promotes mid-turn.
- **"model-visible ⟺ logged"**: anything the model sees must already be in the log. Turn output, tool results, interrupted tools, even the ambient AGENTS.md system context, are appended before they become visible.

## 4. Durable admission inbox (session)

Prompts are admitted to a durable `session_input` cell *before* becoming model-visible.

- Idempotent `admit`: same id + same content returns the same receipt; same id + different content is a conflict (throws). The durable log is the source of truth, and a **synchronous re-check of the inbox map** runs after the awaited `#findDurable` interleave point (no `await` between it and the append), so two interleaved admits of the same new id collapse to one durable `PromptAdmitted` rather than double-inserting.
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
- **Cancellation durability**: `runTurn` wraps the stream in a try/catch so any **partially buffered assistant parts** (already emitted live) are flushed to the log before rethrowing a cancellation — a stream aborted mid-turn no longer loses the partial assistant message, so model-visible ⟺ logged holds even on interrupt. A **cancelled tool** settles as `Tool execution interrupted` (matching the cross-process convention) rather than a generic `tool error`, so a resumed session treats it as a durable interruption, not a replayable side effect.
- Model-relative lowering happens in `toLlmMessages`: when the continuation model differs from the producing model, reasoning degrades to plain text and the opaque provider reasoning payload is dropped (so one model's thinking format is never fed to another).

## 7. Plugin registration surface (plugin)

Five capability kinds register through one seam — `tool` / `agent` / `command` / `hook` / `provider` — so consumers pull from the registry rather than branching on types inline.

- `PluginRegistry` stores capabilities by kind + name; `register` returns a disposer; `registerAll`/`dispose` enable bulk unload; a `provider` capability can register into a `Container` and have its disposer composed into the plugin's own.
- Directory-as-registration-surface: `discoverPlugin` reads `agents/`, `commands/`, `hooks/`, `tools/` by convention; `hooks.json` events are whitelisted (`HOOK_EVENTS`) so unknown events are skipped rather than silently registered.
- **Wired into `createApp`**: `AppConfig.pluginsDir` discovers a plugin folder by convention and registers its capabilities into the (fresh or injected) `PluginRegistry`. Tool assembly is **additive + ordered**: explicit > plugin > builtin, with the builtin fs toolset always present as the baseline — a plugin/override no longer silently replaces `read`/`write`/`edit`. `toolMap` is first-wins so higher-priority tools are never shadowed by a later duplicate. A discovered JSON tool is a declared-but-unimplemented stub that **fails loudly** at execution (never a silent no-op).

## 8. Workspace context (core/agent/context)

Ambient `AGENTS.md` is a Context Source. `discoverWorkspaceContext` walks upward from the session location (contained within a root), realpath-normalizing for containment; `composeSystemContext` orders deepest-first. It is admitted as a System-role context message once per session (reused, not re-appended per prompt).

## 9. Runtime assembly + transport layering (runtime)

`createApp` lives in `packages/runtime` and is the **domain assembly** shared by every transport. It composes the seams (store + inbox + llm + agent + tools), injects the ambient system context, and drives `runSession`. It holds no transport concerns.

- `App` exposes `sessionId`, `events` (the EventStore), `onEvent(listener)` (live streamed model/tool events for incremental rendering), `prompt(text)` → `PromptResult`, and `resume()`.
- `PromptResult` is structured (`step`, `needsContinuation`, `finish`); a shell renders it (e.g. `done (N steps)`) rather than a bare string, so the long-horizon `needsContinuation` signal is preserved.
- `AppEvent` is aliased to `LoopEvent` (single source from core) — `text`/`reasoning`/`tool`/`tool-result`/`step`/`error`/`done` — so the corpus stays consistent and there's no duplicated live vocabulary.
- The turn loop normalizes every provider-encoded tool `input` (a JSON string) into a JS object at a single boundary, so a tool's `execute` always receives an object regardless of protocol — no defensive parsing in tools.
- Transports are thin: `cli`/`web`/`desktop`/`sdk` only read input, render output, and call `createApp`. They do not own any domain logic.
- **Stable session identity**: `createApp` defaults the session id to `stableSessionId(workspace)` (core), so every transport re-attaches to the same per-workspace log across a restart without forcing a name. This is a domain rule in core, not a CLI-only derivation.
- **Persist-store failure is surfaced**: `createStore` `mkdir`s the dataDir and rethrows a clear error when the `.keep` write fails, instead of swallowing it then crashing opaquely in `SqliteEventStore.open`.
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
  2. A runtime-enforced data contract: each node `produces` a slot (`produces ?? id`), `validate()` rejects a node whose `consumes` references a slot no ancestor produces, **rejects a duplicate `produces` slot id across nodes** (a later node would silently overwrite an earlier one's output — last-writer-wins), and `buildInput` fails on a missing slot (never silently empty).
- **Concurrency**: `validate` first (edge de-dup, cycle/unknown/self dep detection); event-driven worker pool via `pump()` (a settled node re-pumps, never a serial or per-layer `Promise.all` join); per-node `AbortController`; per-node subagent session isolation (each node is its own `runSession` with its own id/agent/model — **not** a runtime DI scope). The concurrency cap is **hard**: `pump()` counts already-`running` nodes (`running.size`) toward the cap, so a wide fan-out cannot exceed the declared `concurrency` by over-claiming nodes still in flight from an earlier pump. `runNode` moves its `NodeStarted` emit inside the try so an unexpected throw settles the node instead of leaving it claimed-`running` with the pump swallowing the error.
- **Replay integrity**: `replayDag` folds the log, reconciles a `running` node (process died mid-node) to `aborted`, then **seeds every declared node to `pending` and applies `cascadeTerminal`** — so a dep-non-succeeded node replays `skipped` (a live run sets this via `pendingSkips`) instead of re-appearing `pending` forever. This is the R1 "replayable DAG" entry point.
- **Cost-down model selection (goal #3)**: each node resolves its effective model through a pure `resolveNodeModel(node, deps)` before the run (pre-flight). Precedence: explicit `node.agent.model` wins → else if `deps.costDown` a cheaper model is chosen (role/preset from `deps.modelPresets`, falling back to `deps.cheapModel`) → else inherit `deps.defaultModel` (the parent model) → else a hard `DAGError` (never the bogus `"model"` literal). Setting both `role` and `preset` is a hard `DAGError` (ambiguous selection). The resolved model is persisted in `DAG.NodeStarted.model` and surfaced through `foldDAG.models` / `replayDag(...).models`, so a restart can still see which model each node actually ran under. This is cache-safe by construction: each node is a fresh, one-shot subagent session with its own system prefix, so switching a node's *model* never perturbs an existing session's Anthropic `cache_control` prefix.
- **Failure/termination**: state machine includes `aborted`; `abortGraph` stops claiming new nodes, aborts in-flight, and marks running nodes `NodeAborted` / pending `NodeSkipped` (deduped via `emitAbort`); scheme-B cascade turns a dep-on-`non-succeeded` node into `skipped` without spawning it (persisted via `pendingSkips`, flushed before return).
- **Honest scope**: cross-session effect delivery and a full `SessionManager` stay M4; DAG events use `aggregate:"dag"`.

## 13. Builtin toolset — the agent's hands (M3.5)

Gives DAG nodes and sessions concrete tools to act, so cost-down (cheap model runs a subagent) is meaningful. Six tools: `read` / `write` / `edit` / `list` / `search` / `bash`, all implementing the existing `Tool` contract (`execute(input, ctx)`), so no core changes to the seam.

- **Workspace sandbox**: every fs tool resolves user paths through a single shared `resolveInWorkspace(root, p)` in `packages/runtime/src/tools/path.ts` — normalization (`path.resolve`), then `realpath` of the deepest existing ancestor (so a workspace-internal symlink/junction pointing outward cannot pass a lexical prefix check, and write targets that don't exist yet still resolve), then a containment check that is a boundary + win32 case-fold (`p === root || p.startsWith(root + sep)`, drive letters folded) so `G:\repo` is not a prefix of `G:\repo-evil`. No per-tool path checks (path-level "no scattered branches"). TOCTOU residual risk is accepted and documented.
- **Symlink escape is closed twice**: `read`/`write`/`edit` go through `resolveInWorkspace` (realpath → reject); `list`/`search` walk via `collectFiles`, which uses `lstat` and **skips** any symbolic link so a link inside the workspace is never followed into (or enumerated from) outside. This was a real bug found in review and is regression-locked by tests.
- **Bash is outside the sandbox**: it is not constrained by the fs sandbox — enabling it authorizes the session to read/write/execute any reachable path with the process user's permissions. This boundary is explicit, not implied by fs-tool sandboxing. Off by default (`enableBash`); explicit opt-in. Non-zero `exitCode` is data (the model self-corrects), not an error; `cwd` pinned to the workspace; model-supplied `timeoutMs` clamped to a 60s cap (default = cap, so a missing value is never a 1ms kill-all); Windows kill uses `taskkill /T /F` so a `cmd /c` grandchildren tree is torn down.
- **Tool semantics**: `edit` rejects `old === new` and empty `old`; empty `new` is a legal deletion; EOL is normalized for comparison but the file's original EOL is restored on write; a multi-hit returns a structured payload (count + line numbers + context) so the model can widen `old`. `read` returns line-numbered output (the cheapest self-correction lever). Errors are returned as data, not thrown (so the model sees and self-corrects); `.git`/`node_modules`/binary are excluded from traversal. Refinements found in a granularity review: `search` never produces a false "no match" — a byte budget stops the walk and reports `budgetExceeded: true` rather than silently dropping later files; `list`/`search` globs are case-folded on win32 (Bun.Glob's `caseInsensitive` does not apply to literal extensions, so we fold the pattern + target) so they agree with read/write casing semantics; `read` flags `offsetBeyond` instead of a silent empty result.
- **Wiring**: `createBuiltinTools({ workspace, enableBash })` in `packages/runtime/src/tools/index.ts`. `AppConfig` priority is explicit `tools` (empty array = deliberate none) > plugins > builtin; `Workdir` is injected into system context so the first-turn model knows the root; `DagDeps.tools` defaults to the builtin set so DAG nodes keep their hands. `ToolCtx` gained `signal?: AbortSignal` (a small core change) so a long-running bash subprocess can honor a session interrupt rather than leaking past it. Every path/command tool routes through execpolicy (see §14): **`read` uses `decidePath` + `approve` like `write`/`bash`** and fails closed when no policy is injected — it no longer bypasses the permission layer with only a hardcoded `.newhorse` regex.
- **Honest scope**: no web fetch, no image read (multimodal fast-follow), no memory tool (M4); fine-grained permissions (execpolicy 自举) stay M4.

## 14. Execpolicy — the tool-layer permission floor (M4)

The bash tool is outside the fs sandbox, so the runtime needs a permission layer that decides `allow` / `prompt` / `forbid` for every command and path before it touches the system. It is two parts: a **host-owned rules file** (user consent) plus a **data-driven heuristic floor** that a rule can never override. Strictest-wins (`max`): `forbid < prompt < allow` — a user rule cannot upgrade a dangerous command to `allow`.

- **Seam shape** (`packages/runtime/src/tools/execpolicy.ts`): `createExecPolicy({ rules?, rulesFile?, rulesDir?, onApprove?, audit? })` returns `{ decide(cmd), decidePath(path), approve(req) }`. `createBuiltinExecPolicy({ dataDir, workspace, ... })` assembles rulesFile from `dataDir/projects/<hash>/rules.json`, bootstraps allowed prefixes on first run, and wires the interactive `approve` gate + audit.
- **Decision axis**: `Decision = "allow" | "prompt" | "forbid"`; `max(a, b)` gives `forbid > prompt > allow`. The heuristic floor is always the strictest constraint; a `prompt` command with no interactive approve gate (**fail-closed**) collapses to `forbid`/deny.
- **Rules** (5 kinds, host-owned file, matched longest-prefix-first / normalized paths): `prefix_rule` (command), `network_rule` (host allow/skip), `path_rule` (path allow/skip), `shell_wrapper` (a wrapper's inner exec is detected), `host_executable` (non-shell host code the heuristic cannot vet). Bootstrap write-back is atomic (temp + rename) and **never** writes a BANNED prefix/credential path.
- **Heuristic floor** (data-driven, platform table): script-file / inline-code interpreters, unparsable shell control (fail-closed), and a `COMMON_DANGEROUS` regex table (`rm -rf`/`sudo`/`curl|sh`/`find -exec/-delete`/`sed -i`/`-rf` in any flag order/`su`/privesc + namespace wrappers/`env -S`/dot-source/`&;|`). BANNED_RULES_PATH forbids any argv/path referencing the host rules dir or a protected prefix — a model must never read/write `.newhorse/**`.
- **Whole-argv interpreter scan** (`interpreterSpecial`): any token that is a shell family (`SHELL_NAMES` bounded set + busybox/fish, version-normalized so `bash5.2`/`bash-5.2`/`zsh-5.8`/`dash-0.5`/`ksh-2020` reduce to `bash`/`zsh`/`dash`/`ksh`) or interpreter, when it is the exec head **or** is followed by a code flag / script-path / stdin-redirect / next interpreter → prompt. The tail scan is **unbounded** because transparent `-s`/`-l`/`--` shell flags are repeatable and operand-free (`bash -s -s -l -c id` would otherwise push `-c` past a fixed window). It also **recurses into whitespace-containing argv tokens** so a **quoted remote/shell-host sub-command** (`ssh host 'sh -c id'`, `ssh host "python -c x"` — which the tokenizer collapses to one token invisible to the scan) no longer rises to `allow`; benign quoted strings (`echo 'x'`, `ssh host ls`) stay `allow`. This closes the "un-enumerated wrapper" hole (`taskset bash -c`, `runuser -u root -- bash -c`, `chroot / bin/bash -c`) without an open-ended `*sh` ends-with match.
- **Closed-loop review** (per AGENTS.md): this mechanism went through 14 adversarial review rounds; each MUST-FIX (version-normalization, stdin-redirect exec, masked-`-c` by stackable flags) was closed and regression-locked. Residual documented in `specs/v2/m4-execpolicy.md` §6: package-manager/language-runner/data-CLI hosts (`npx`/`npm exec`/`ts-node`/`sqlite3`/`mysql`/`psql`/`Rscript`/`groovy`/`jshell`/`go run`/`java -jar`/`dotnet run`/`nix-shell --run`/`make -f`/`flake8`), npm/pip/cargo lifecycle, git push/pull/fetch hooks, "any reachable file enableBash=true", non-sh-ending shells (`nu -c`/`rc -c`/`es -c`/`ion -c`), `run-parts --exit-on-error`, privesc/namespace fail-closed over-block. Accepted fail-closed over-block: a shell name used as a plain filename arg (`ls bash file.txt`, `mv bash zsh`) → prompt (conservative, safe).
- **Audit**: a `prompt`/`forbid` decision is recorded to `audit:<sessionId>` (fire-and-forget, best-effort observability); an `allow` is the default and is not noise. `approve` is a single 30s fail-closed gate (a real timeout, never a dangling in-flight prompt after denial).

## Usage

Design docs live in `docs/`. Plans live in `specs/v2/`. When a core mechanism is implemented, record the decision here; when a design materially changes, update this file.

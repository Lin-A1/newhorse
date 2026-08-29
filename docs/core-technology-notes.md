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
- **Entry scoping**: `DAGSpec.entry` (declared roots, default = every in-degree-0 node) is honored, not ignored. `validate()` computes an `active` set = the forward-reachable subgraph from the entry roots (via `dependents`), rejects an unknown entry id, and rejects an entry that has deps (it could never become ready — its deps sit off the entry's forward path). `readyNodes` only dispatches active nodes and `cascadeTerminal` only cascades active ones; a live `runDag` and `replayDag` both reconcile inactive nodes to `skipped` so `waitForTerminal` settles and a replay sees them terminal rather than pending-forever. This makes a partial entry genuinely restrict the run instead of silently running every root.
- **Retry slot discipline**: on a node retry the concurrency slot is freed (`running.delete`) **before** the node flips back to `pending`, and `pump()` skips any still-in-flight id (`running.has`), so a settle-triggered pump cannot double-dispatch the retried node or let a stale `finally` delete the live second dispatch.
- **Honest scope**: cross-session effect delivery and a full `SessionManager` stay M4; DAG events use `aggregate:"dag"`.

## 13. Builtin toolset — the agent's hands (M3.5)

Gives DAG nodes and sessions concrete tools to act, so cost-down (cheap model runs a subagent) is meaningful. Six tools: `read` / `write` / `edit` / `list` / `search` / `bash`, all implementing the existing `Tool` contract (`execute(input, ctx)`), so no core changes to the seam.

- **Workspace sandbox**: every fs tool resolves user paths through a single shared `resolveInWorkspace(root, p)` in `packages/runtime/src/tools/path.ts` — normalization (`path.resolve`), then `realpath` of the deepest existing ancestor (so a workspace-internal symlink/junction pointing outward cannot pass a lexical prefix check, and write targets that don't exist yet still resolve), then a containment check that is a boundary + win32 case-fold (`p === root || p.startsWith(root + sep)`, drive letters folded) so `G:\repo` is not a prefix of `G:\repo-evil`. No per-tool path checks (path-level "no scattered branches"). TOCTOU residual risk is accepted and documented.
- **Symlink escape is closed twice**: `read`/`write`/`edit` go through `resolveInWorkspace` (realpath → reject); `list`/`search` walk via `collectFiles`, which uses `lstat` and **skips** any symbolic link so a link inside the workspace is never followed into (or enumerated from) outside. This was a real bug found in review and is regression-locked by tests.
- **Bash is outside the sandbox**: it is not constrained by the fs sandbox — enabling it authorizes the session to read/write/execute any reachable path with the process user's permissions. This boundary is explicit, not implied by fs-tool sandboxing. Off by default (`enableBash`); explicit opt-in. Non-zero `exitCode` is data (the model self-corrects), not an error; `cwd` pinned to the workspace; model-supplied `timeoutMs` clamped to a 60s cap (default = cap, so a missing value is never a 1ms kill-all); Windows kill uses `taskkill /T /F` so a `cmd /c` grandchildren tree is torn down.
- **Tool semantics**: `edit` rejects `old === new` and empty `old`; empty `new` is a legal deletion; EOL is normalized for comparison but the file's original EOL is restored on write; a multi-hit returns a structured payload (count + line numbers + context) so the model can widen `old`. `read` returns line-numbered output (the cheapest self-correction lever). Errors are returned as data, not thrown (so the model sees and self-corrects); `.git`/`node_modules`/binary are excluded from traversal. Refinements found in a granularity review: `search` never produces a false "no match" — a byte budget stops the walk and reports `budgetExceeded: true` rather than silently dropping later files; `list`/`search` globs are case-folded on win32 (Bun.Glob's `caseInsensitive` does not apply to literal extensions, so we fold the pattern + target) so they agree with read/write casing semantics; `read` flags `offsetBeyond` instead of a silent empty result.
- **Wiring**: `createBuiltinTools({ workspace, enableBash })` in `packages/runtime/src/tools/index.ts`. `AppConfig` tool priority discriminates on `!== undefined`: `tools: undefined` assembles the plugin + builtin baseline (plugin wins a name collision); a provided **non-empty** array is an additive override (explicit > plugin > builtin, first occurrence wins); an explicit empty array is the "override = no tools" signifier (no fs hands). `Workdir` is injected into system context so the first-turn model knows the root; `DagDeps.tools` defaults to the builtin set so DAG nodes keep their hands. `ToolCtx` gained `signal?: AbortSignal` (a small core change) so a long-running bash subprocess can honor a session interrupt rather than leaking past it. The four mutating/executing tools route through execpolicy (see §14) — read/write/edit/bash; `list`/`search` are read-only and protected by the traversal exclusion (lstat-link skip + protected-base refuse), not by a policy decision: **`read` uses `decidePath` but honors ONLY `forbid`** — a `prompt`-level sensitive suffix (`.env`, `.ps1`) is NOT gated for read (the model legitimately needs to inspect those to edit them, and denying them deadlocks a DAG/non-interactive child). This is a deliberate deviation from the "`read` ≈ `write`/`bash`" sketch: read stays read-only, so it denies only protected paths, never prompts. `write`/`edit`/`bash` do `forbid` → denied, `prompt` → approve gate (fail-closed). Because read/write/edit/bash read `ctx.execPolicy`, `runDag` injects a default workspace policy (when the caller does not) so a DAG subagent can actually act — the heuristic floor allows workspace fs, forbids `.newhorse`/`.git`, prompts on credentials — instead of every node being denied by `denyAllExecPolicy` (goal #3: cost-down is only meaningful if a node has hands).
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

## 15. Uniform error taxonomy + retry (llm transport)

Every provider failure the loop can see is classified once, at the transport boundary, and surfaced as a canonical `provider-error` event (never a provider-string masquerading as a normal `stop`).

- **Taxonomy** (`classifyHttpError` in `packages/llm/src/transport.ts`): status → semantic code — `400` context-overflow (when the body mentions context/length/token), `429` rate-limited, `401`/`403` auth, `404` not-found, `413` too-large, `422` invalid-request, `>=500` server, else unknown. `retryable` is `429 || >=500`.
- **Retry**: `streamWithRetry` retries ONLY retryable errors with exponential backoff + jitter (500ms base, 8s cap, `maxRetries` default 3). Non-retryable (auth/not-found/too-large/invalid/context-overflow) throw immediately — retrying a 401 or a context-overflow would burn budget and still fail.
- **Why it matters**: a provider failure used to be able to finish as `stop` (masking the error); the loop now sets `finish: "error"` on `provider-error` and the smoke suite asserts on it (not just `finish`). This is the "provider failures no longer masquerade as stop" fix — regression-locked in `llm/adapter.test.ts`.
- `LlmCancelled` (transport) and `AbortError`/`DOMException(20)` (fetch) are detected structurally in the loop's `isCancelled` — core cannot import the llm package, so cancellation is matched by name/tag, never by import.

## 16. Plugin directory discovery (plugin)

Directory-as-registration-surface (claude code's strength), layered on the five-kind seam:

- **Convention**: `plugin.json` (metadata), `tools/` (`*.ts`/`*.json`), `agents/` (`*.md` + frontmatter), `commands/` (`*.md` + frontmatter), `hooks/` (`hooks.json`, whitelisted against `HOOK_EVENTS`), `skills/` (`SKILL.md` folders or flat `<name>.md`).
- **Skills are content, not capability**: AGENTS.md's three-level skill disclosure (metadata → SKILL.md → references/scripts) is a content convention. `discoverSkills` reads levels 1–2 (frontmatter name/description + SKILL.md body) and exposes them as `SkillDisclosure` — NOT a registry kind, and currently **no session/loop consumer reads it** (it is wired for a future skills loader; see §17). Level 3 (`references/`/`scripts/`) is on-demand, never eagerly loaded.
- **Tool loading**: a JSON tool declaration registers as a stub whose `execute` throws loudly ("no registered implementation") — never a silent no-op. A `.ts` tool definition is currently skipped by discovery (plugin code execution is a later concern); it is never registered as a tool it cannot run.
- **Hook command execution**: `executeCommand` splits the command line with a shell-aware `shellSplit` (quoted args, adjacent-quote concat, double-quote `\"`/`\\` escapes) instead of a naive `split(" ")` — a hook command like `rg 'foo bar' src` previously broke into `["rg", "'foo", "bar'", "src"]`.

## 17. Known placeholders (declared but not yet consumed)

The registration surface is complete; some kinds register but have no consumer yet. These are M1-scope decisions, noted so a later session does not mistake a gap for a bug:

- **`agent` / `command` / `hook` capabilities register** through the seam (discovery) but **nothing calls `registry.list("agent"/"command"/"hook")`** — the agent loop consumes only `tool`. Plugging in a consumer is M2+ (agents → spawn surface, commands → CLI dispatch, hooks → turn-loop timeline).
- **`discoverSkills` has no consumer** — `SkillDisclosure` is exposed for a future skills loader; no session or loop reads it yet.
- **`plugin.json` metadata is not parsed** — discovery honors the `tools/ agents/ commands/ hooks/ skills/` directories but does not read a plugin manifest.
- **`discoverPlugin` does not load `.ts` tool definitions** — JSON only (stub `execute` throws). Plugin TS code loading is a later concern.
- **`hub.spawn` writes `Session.Created` with `location: ""`** — full workspace inheritance for child sessions (AGENTS.md discovery + system context reaching sub-nodes) is **Phase 2 (prerequisite to orchestration)**, not M4.
- **`hub.interrupt` / `hub.send` return `{ implemented: false, pending: true }`** — cross-session effect delivery is M4; the butler tools report the honest `implemented` flag, never a fake success.
- **execpolicy bootstrap (`bootstrapAppend`) is implemented but not wired** to the approve flow (persisting a user's `allow` decision as a rules entry is deferred; the interactive flow currently approves per-request only).
- **Memory is a reserved seam (Phase 4)** — not yet in schema: no `MemoryRead`/`MemoryWrite` event, no `memory` message kind, no memory tool. The DECISION (from review + AGENTS.md §5) is recorded: two events + one message kind + a registry fold branch, with a **pluggable vector/embedding index provider** (like `EventStore`); core keeps only the event-sourced index. Timeline: schema reserve now, tool afterwards. The vector layer is a replaceable provider, never a core dependency.
- **No web fetch / image read / memory tool** (M4 fast-follows).

## Usage

Design docs live in `docs/`. Plans live in `specs/v2/`. When a core mechanism is implemented, record the decision here; when a design materially changes, update this file.

**Status**: `specs/v2/` files are the plans (each now header-stamped with implemented / deferred); `docs/core-technology-notes.md` is the implemented-state record. Keep the two aligned: when a spec's status flips to implemented, record the decision in here and link the section.

## 18. Runtime server — HTTP/SSE boundary over createApp (Phase 1)

`packages/server` is the transport boundary for the domain assembly — it parses HTTP, maps endpoints to `App` members, and streams `LoopEvent`s. Server holds no domain logic (per AGENTS.md "transport only").

- **Entry**: `createServer(config)` → `ServerHandle { baseUrl, appFor, stop }`. `Bun.serve` on `host` (default `127.0.0.1`) + `port` (default `3927`; `port:0` picks an ephemeral port in tests).
- **Sessions**: a process-local `Map<sessionId, App>`. `POST /v1/session` creates-or-attaches via a `sessionConfig(create)` factory — the transport owns provider/config choice; the server pins `sessionId: id` so the map key always equals `app.sessionId` (createApp would otherwise derive a workspace-stable id).
- **Endpoints** (see `specs/v2/server.md` §1): `GET /v1/health`, `POST /v1/session`, `POST /v1/session/:id/prompt` (SSE), `POST /v1/session/:id/steer`, `POST /v1/session/:id/interrupt`, `GET /v1/session/:id`, `GET /v1/sessions`, `GET /v1/audit`, `GET /v1/session/:id/events`.
- **SSE lifecycle (the load-bearing part)**: `promptStream` subscribes `onEvent` BEFORE `app.prompt()` is invoked (no missed events), emits one `data: {json}\n\n` per loop event, then a `{type:"result", ...PromptResult}` and `data: [DONE]\n\n`. Every `emit`/`close` is guarded by a `closed` flag set by the stream's `cancel()` + try/catch — **a client disconnect (browser nav / network drop) must never crash the process**: a dead controller enqueue/close is a no-op, not an unhandled rejection (this was a real MUST-FIX found in adversarial review + empirically proven with a raw-socket probe). `req.signal → app.interrupt()` additionally cancels the in-flight prompt on client disconnect so the run settles as interrupted instead of leaving a zombie.
- **Security**: optional `token` — all requests must carry `Authorization: Bearer <token>` (constant-time compare) — else loopback-only (`host` must be `127.0.0.1`/`::1` or every request is 403). Malformed JSON body → 400 (not a silent default config — a real SHOULD-FIX gap caught in review).
- **Lifecycle**: `stop()` interrupts in-flight prompts, waits a tick, then `server.stop()` and closes event stores (Sqlite `close()` is not on the `EventStore` interface, so it is invoked via a structural cast).
- **Known Bun bug (1.3.14) — process-level panic on real client disconnect**: a raw-TCP client disconnect mid-prompt (in-flight `runSession` draining into a cancelled SSE stream) triggers a Bun **internal assertion panic at process exit** (`panic(main thread): Internal assertion failure` — Bun reports "This indicates a bug in Bun, not your code"). Bisected (independent review, 2026-08-29): a *plain* cancelled SSE stream is clean (minimal server); a *bare* `app.prompt` is clean; **only the combination of an in-flight createApp prompt + cancelled stream panics** — including variant G which emits **zero** post-cancel events, so it is NOT our emit guard. The JS-level crash (unhandled rejection from a closed controller) **IS fixed** by the `cancel()`-flagged try/catch guard; the residual is Bun-version-bound.
- **Status**: the disconnect regression test is **skipped** (`it.skip`, correct `Content-Length: 21` + `entered` assertion) until the Bun fix lands — it deterministically panics on 1.3.14. Re-enable after a Bun upgrade that fixes the SSE-cancellation assertion. The `req.signal → app.interrupt()` link is verified to fire on real socket destroy (not dead code) and is the correct design; it just can't rescue the process-level Bun panic on this version.
- **Recommendation**: upgrade/pin Bun to a version where the `Bun.serve` SSE-cancellation assertion is fixed, then re-run the skipped test. Do not ship a fast-draining SSE endpoint on 1.3.14 without accepting this known crash on client disconnect (rare — only mid-prompt disconnect + stop).

## 19. Child-session workspace inheritance + context provider seam (Phase 2)

Child sessions (DAG node, spawned agent) previously ran with `location: ""` — no AGENTS.md, no Workdir, no model-visible direction. Phase 2 fixes the inheritance through a **pluggable provider**, not a hardcoded branch.

- **Seam**: `SessionContextProvider = (workspace: string) => Promise<string>` (assemble the model-visible system block). Default = `defaultContextProvider` in `packages/runtime/src/context.ts` — discovers AGENTS.md upward + composes, prepends the `Workdir:` line. Same behavior the primary `app.prompt` always had, now extracted so child sessions reuse it.
- **Injection** (`ensureSystemContext` in `app.ts`): appends a `system` message to the session log IF none exists yet (first-turn-only, per "model-visible ⟺ logged"). Shared by `app.prompt` (primary) and `dag-runner.runNode` (child).
- **Location inheritance**:
  - `dag-runner.ts` — `Session.Created { location: workspace }` (was `""`); workspace = `deps.workspace ?? process.cwd()`.
  - `hub.ts` — `createSessionHub(events, open, workspace?)`; `spawn` writes the parent's workspace.
- **Pluggability**: `AppConfig.contextProvider?` and `DagDeps.contextProvider?` — a caller can inject a custom provider (e.g. a narrower scope for a child) with no branch; default is the AGENTS.md discovery. Test `dag-runner.test.ts` "contextProvider is pluggable" proves a custom provider's text lands as the child system message.
- **Scope**: this phase delivers the base; **driving a spawned child + result promotion** (the model-orchestration side of "live child") is the next slice (see `specs/v2/child-session.md` §1.4, Phase 3 in `plan.md`).

## 20. Model orchestration base + durable DAG resume (Phase 3)

The "brain" behind model-driven orchestration and the DAG: a shared child driver and a recoverable graph.

- **`driveChildSession`** (`packages/runtime/src/session-manager.ts`): the ONE path that creates and RUNS a child — `Session.Created` (location=workspace) → `ensureSystemContext` (AGENTS.md/Workdir first-turn) → `inbox.admit` (steer) → `runSession` → returns `{ finish, settled, text }`. Used by the DAG dispatcher (runNode) so a node's child is a real session, and (future) by hub.spawn.
- **Durable slot**: `DAG.NodeResolved` now persists `output` (truncated 64k) so `foldDAG`/`replayDag` can rebuild the slot store from the log — no longer a purely in-memory `Map`.
- **`resumeDag(dagId, spec, deps)`**: runs `runDag` with `resume:{ dagId }` — reuses the aggregate (no re-declare), seeds `status` from the fold (a node left `running` by a crash → `pending`, re-dispatched), rebuilds the slot store from `NodeResult.output`. A crashed graph is RE-DRIVEN, not just viewed as a corpse.
- **Hub driver seam**: `createSessionHub(..., driver?: ChildDriver)` — a pluggable optional driver. When supplied, `spawn` actually runs the child; otherwise it's persisted-but-not-driven (honest stub).
- **Closure (spawn → live child → promote)**: `ToolCtx.spawnFrom(parentId, model, prompt?)` carries the task; the app wires a driver into the hub — `driveChildSession` runs the child (Created → system context → admit → runSession), appends `Session.Settled`, and promotes the child's final text into the PARENT inbox as a steer (`principal:"parent"`) so the parent's next turn sees the result. Test: `hub.test.ts` end-to-end.
- **Known remaining gaps**: `hub.send`/`interrupt` are still stubs (cross-session effect delivery is M4 SessionManager); parent promotion is a steer (it wakes the parent on its NEXT drain — the parent is not actively re-driven mid-idle); `followup_task` status querying reads `Session.Settled` (available) but the tool itself is not yet registered.

# AGENTS.md

> This is the overall target for newhorse **v2**, not a stage-scoped note. It should remain true across M1/M2/M3 and beyond. Per-mechanism detail lives in `specs/v2/`; this file is the stable north star.

## Positioning

newhorse is a **model-agnostic, non-captive agent engine**. It is not trying to prove it is better than any other framework — it is trying to be **usable and extensible** for daily work, and to **not be captive to any single vendor, model family, or internal architecture**.

> Not bound to a single model; orchestrate agents with declarative scheduling instead of being orchestrated by another framework's runtime.

The three pillars, each answering a different kind of captivity that existing frameworks suffer from:

| Pillar | Answers captivity from | How |
|---|---|---|
| **Model-agnostic** | codex overfits the response API and shells out to remote compaction; claude code rejects other brands | multi-adapter LLM seam, local context/compaction, no remote-only behavior |
| **Not architecturally captive** | opencode locks scheduling inside its runtime; deepseek-harness is too entangled to extract clean blocks | self-implemented seam (Service Definition / Provider / Consumer); DAG scheduling lives outside the runtime and is pluggable |
| **Usable + extensible** | all of the above | engineering rigor aligned with claude code, widened plugin registration surface |

**Deliberate borrowing (not "original" claims):** every mechanism cites its origin in `specs/v2/`. We copy the good parts and drop the bad parts. Do not restate borrowed behavior as self-built in docs. This principle applies to the whole file, including the "What We Want" section below.

## What We Want (core differentiators)

These are the priorities that define newhorse — the things worth doing and worth highlighting. Keep them in mind when designing and when comparing against codex / claude code / opencode.

### 1. Declarative DAG scheduling + model-driven orchestration — two faces of one base

**DAG is how we schedule planned subagent batches**, and it is **declarative, not literal**. `spawn_agent`-style tools are how a running model orchestrates dynamically. They share one base (a real, driver-driven child session) and are not competitors.

- **DAG (batch/planned form)**: the user declares **dependencies** (`dependsOn: [nodeId]`) and the graph shape; the runtime derives execution order (topo sort), readiness, and wakeups. The user does not write an imperative script of "spawn A, wait, spawn B". A node = one subagent delegation. Execution = ready queue + event wakeup, **no join blocking**. It is **not a literal transcript** and **not a retrospective graph**; we draw the graph forward, in advance.
- **Model orchestration (dynamic form)**: a running agent can `spawn_agent` / `send_message` / `followup_task` at turn boundaries. The model is the scheduler; the runtime guarantees the child is **actually driven** (not a dead row), receives the parent's workspace context, and its result is **promoted back** on completion.
- Both sit on one foundation (a **Phase 2 target** — today `hub.spawn` leaves the child undriven and DAG children run with `location: ""`): a child session that (a) inherits the parent workspace / `AGENTS.md` context, (b) is driven by the turn loop, (c) can be resumed by id. DAG just draws edges over that foundation; tools express one spawn at a time.
- Contrast: codex spawns subagents from a **model driving a single turn** and only records the resulting graph afterward; opencode uses a single-layer BackgroundJob; claude code uses asyncRewake. None of them treat a graph as a declarative schedule. That is our real space.
- **Key tradeoff:** each node / spawn can pick its own model (see #3), so you can fan out cheap subagents and spend the expensive model only at decision points.

### 2. Long-horizon work — agents that keep working

An agent must be able to **work for a long time** without the user babysitting it, and **survive restarts**.

- Durable state everywhere: the append-only session log, the admission inbox, and completed event boundaries are persisted so a turn can be resumed after a crash/restart.
- Background / continuable child semantics: a subagent can be left running, its result **promoted back** on completion, and a `task_id` can resume it. A child is a real, driven session — never a dead row.
- **Child-session workspace inheritance is a hard prerequisite**: every spawned / DAG-node child session must carry its parent's workspace (and therefore its `AGENTS.md`/`Workdir` context) — a child created with `location: ""` has no idea what project it's in and is useless as a fan-out target.
- Settlement is durable: a finished step records its boundary; an interrupted in-flight tool fails as `Tool execution interrupted` rather than being silently replayed.
- No process-local-only guarantees that die with the runtime: long-horizon work must be reconstructable from the log, not from live memory.

### 3. Cost-controlled subagent models (switchable)

Subagents can use a **different (usually cheaper) model** from the parent, to balance cost.

- Default: subagent inherits the parent's model.
- Switchable: a `costDown` policy (by role / by preset / by node) drops un-specified subagents onto a cheaper model.
- Model-agnostic: an independent model still goes through the same four-axis Route and a single LLM vocabulary — it is not bound to the parent's provider.

### 4. Model-agnostic output quality

We are model-agnostic but **we want the output to be good**, so we borrow how others achieve good model behavior:

- A four-axis Route (Protocol / Endpoint / Auth / Framing) that decouples the API shape from deployment, so OpenAI-compatible, Anthropic, and others all reuse one protocol.
- A single canonical `LLMRequest` / `LLMEvent` vocabulary across providers; provider quirks live inside the protocol.
- **Model-relative history lowering:** when the model changes, reasoning degrades to plain text rather than feeding one model's thinking format to another (a common cross-model failure).
- Uniform error taxonomy + retry, shared compaction path.

### 5. Usable + extensible

- Directory-as-registration-surface: put `agents/`, `skills/`, `commands/`, `hooks/` in the right place and they are discovered — no central registry required (claude code's strength).
- Three-level skill disclosure (metadata → SKILL.md → references/scripts): a skill is a **content** convention, loaded on demand by the model through a `skill` tool (**Phase 4 target** — today `discoverSkills` is implemented but has no consumer). The catalog (name + description) stays light, the body is fetched only when the model names the skill. Skill content is served by a tool so it never drifts from the runtime.
- Deterministic command hooks + LLM-decision prompt hooks: registered hooks must have real consumers (stop / pre-tool-use) — a hook registry with zero listeners is a decoration.
- Widened plugin registration surface: tools + agents + commands + hooks + providers, plus Codex-style declarative resource packages (skills / mcp / apps).
- **Memory is a runtime capability with a reserved seam** (schema design recorded in `docs/` §17; **Phase 4 target** — not in schema today): `Session.MemoryRead` / `Session.MemoryWrite` events + a `memory` message kind so "model-visible ⟺ logged" holds; the vector/embedding index is a **pluggable provider**, not part of core. Timeline: schema reserve now, tool afterwards.

## Workspace Awareness

The runtime treats **AGENTS.md as an ambient, model-visible context source** — the same way project instructions shape behavior. **Primary-session discovery + first-turn admission is implemented; change-observation is a requirement NOT yet wired** (context is read once on the first prompt, never re-checked — the "observed, checked for changes" clause is a target). Child-session inheritance is required before orchestration (Phase 2). Requirements:

- The runtime discovers **workspace AGENTS.md** (and upward-project ones) automatically, starting from the session location.
- A workspace AGENTS.md is a Context Source: it is observed, checked for changes, and admitted as model-visible context. *Change-observation is a known gap (no fs.watch / mtime check today).*
- **The inheritance chain is explicit**: a child session inherits its parent's workspace; `Session.Created.location` MUST be filled with the workspace (never `""`), and the same first-turn system-context composition must run for the child — otherwise a fan-out cheap subagent is working blind.
- The engine's own AGENTS.md is not privileged over a project's — it is the fallback/default when no project one exists.
- Do not conflate this file (the project-owner's target) with any single `AGENTS.md` semantics bound to one model vendor.
- This file sets the direction for the engine; a workspace AGENTS.md sets the direction for that project's sessions. Both are runtime inputs, not hidden configuration.

## Environment & Tech

- Workspace root: the repo. Default branch is `dev`; `v1` holds archived v1 code.
- Stack: **Bun + TypeScript + bun:sqlite** (no Effect/Drizzle runtime dependency in the engine itself — those are only referenced where necessary; the four-axis LLM route is self-implemented, and Drizzle if needed is confined to app-side persistence, not core). When the runtime reads AGENTS.md, it treats it as durable model-visible context, not as code it executes.
- **Record core-technology designs in `docs/`**: whenever a core mechanism is designed (a seam, the LLM vocabulary/Route, event-sourcing shape, DAG scheduling, the turn loop, scope isolation, etc.), capture it as a design note in `docs/` alongside the code. `specs/v2/` holds the plan; `docs/` holds the implemented/decision design. Design-first before code: write the concept down, then build. Keep these notes current when the design materially changes.
- **Memory / skills are Phase 4-direction but reserved now**: the schema (events + message kinds) and the tool seam must accept them; the vector index is a replaceable provider, the skill loader is a builtin tool.

## Architecture Boundaries

- Move behavior out of large application services into plugins. Core services are small, typed containers that own state, expose simple operations, and trigger hooks where policy or integration-specific logic belongs.
- Keep **session / agent / llm** as three complete seams (Service Definition + Provider + Consumer). Each seam registers as an effect, returns a disposer, and is revocable.
- CLI / server / SDK are transport only; they hold no domain logic.
- Avoid importing app-side modules from core. If a type or concept is needed by core, remodel the domain shape in core first.
- Preserve the "model-visible ⟺ logged" rule: everything the model can see must be in the append-only session log first.
- Keep durable prompt admission separate from model execution.
- **No reverse dependency from core to upper layers** (enforced by package.json dependency direction + lint import rules): core may never import app / TUI / server / CLI / SDK. Keep each package's `dependencies` minimal and only toward lower layers.
- **No scattered type branches**: all capability (tools, agents, commands, hooks, providers) is registered through a seam, never wired as one-off `if`/`switch` chains. A consumer pulls from the seam rather than branching on types inline.

## Extendability (no "sand castle")

The unsaid risk of building incrementally is an architecture that collapses when the next feature lands. This is prevented structurally, not by discipline alone:

- **Freeze the skeleton contract early**: the seam three-part shape (Definition / Provider / Consumer), the canonical `LLMRequest` / `LLMEvent` vocabulary, the event-sourced storage shape `(aggregate_id, seq, type, data)`, and the dependency direction are fixed in M1 and recorded in specs. Changing them late is expensive, so they are locked now.
- **Leave wide mouths for narrow implementations**: M1 implements few concrete capabilities (e.g. only tools), but the registration mechanism must be able to accept agents, commands, hooks, and providers (see `specs/v2/agent-runtime.md` §6). Cost-down (`costDown?`), DAG (`dependsOn?`), and butler interface signatures are declared now even if unimplemented.
- **Stable skeleton, swappable abilities**: the more stable the skeleton, the safer it is to stack features on top. Do not let a concrete provider or a single hard-coded model shape leak into the turn loop or the LLM vocabulary.

## Engineering Rigor

Two standing workflow rules, applied after every piece of work lands:

- **Independent review before "done"**: after designing or implementing any significant mechanism (a seam, the LLM vocabulary/Route, event-sourcing, the turn loop, a protocol, the plugin surface, etc.), delegate a critical review to an independent subagent and iterate until it clears the findings — the reviewer is adversarial about correctness, coupling, and rework risk. "Done" means the review's must-fix findings are resolved, not merely that the code runs. Keep the review output honest; do not restate borrowed behavior as self-built.
- **Design-first, documented**: write the concept down before coding it (or as soon as it is designed), and keep `docs/core-technology-notes.md` current whenever a core-technology design materially changes. See the `docs/` rule under Environment & Tech.

## Branch Model

- Default branch is `dev`.
- `v1` holds the archived v1 code. Do not port v1 services wholesale; port the domain shape and leave behavior behind hooks.
- Use short branch names of at most three words joined by hyphens, no slashes or type prefixes. Examples: `session-recovery`, `fix-scroll-state`.

## Commits and PR Titles

Use conventional commit style: `type(scope): summary`. Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area, e.g. `core`, `tui`, `app`, `cli`, `desktop`, `sdk`, or `plugin`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible.
- Avoid the `any` type.
- Use Bun APIs when possible, like `Bun.file()`.
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity.
- Prefer functional array methods (`flatMap`, `filter`, `map`) over for loops; use type guards on `filter` to maintain type inference downstream.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports (`import { foo as bar }`).
- Never use star imports.
- Prefer dynamic imports for heavy modules only needed in selected code paths. Destructure dynamic import bindings near the top of the narrowest scope that needs them. Keep branch-specific imports inside the branch.
- If a namespace-style value is needed, import the module's own exported namespace by name (e.g. `import { Session } from "@newhorse/core/session"`), then reference `Session.ID`.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

### Control Flow

Avoid `else` statements. Prefer early returns.

### Complex Logic

Make the main function read as the happy path and move supporting details into small helpers below it. Do not over-abstract simple expressions into many single-use helpers.

### Schema Definitions

Use snake_case for field names so column names do not need redefinition as strings.

```ts
// Good (bun:sqlite; core uses raw SQL / typed queries, no ORM in core)
const events = db.query("SELECT ... FROM event WHERE aggregate_id = ?")
```

> Note: core uses `bun:sqlite` directly (no ORM); if an ORM (Drizzle) is used at app/server layer, keep snake_case there too.

## Testing

- Avoid mocks as much as possible; avoid `globalThis.*` unless it is the only option.
- Test actual implementation; do not duplicate logic into tests.
- Tests cannot run from repo root; run from package dirs (e.g. `packages/core`).

## Type Checking

- Always run `bun typecheck` from package directories, never `tsc` directly.

## Current Direction

> 操作化的阶段计划：`specs/v2/plan.md`（Phase 0-5，含每阶段对到哪一差异点）。以下为方向摘要。

**Phase 1 — runtime server is the priority, not the shell.** The runtime domain assembly (`createApp`) is transport-agnostic and complete; CLI/TUI/desktop are thin transports. The next build block is a **runtime server** (HTTP + SSE) exposing `createApp` over a stable boundary: `prompt` / `steer` / `resume` / `listSessions` / `audit` / `interrupt` / `onEvent` (streamed) / future `spawn`. Shells (CLI, TUI) consume it; they hold no domain logic.

**Phase 2 — the "brain": a real child-session base.** Before any orchestration (model-driven or DAG), a spawned child must be a *live, driven session*: it inherits the parent's workspace + AGENTS.md context (`location` must be filled, never `""`), is driven by the turn loop, and its result is promoted back to the parent. Only then is `spawn_agent` / `followup_task` / DAG nodes meaningful.

**Phase 3 — orchestration on that base:** the model-driven tools (`spawn_agent` / `send_message` / `followup_task` / `wait`) are the main entrance; the declarative DAG is the batch/planned form over the same base. Both share the child-session foundation; DAG remains a core differentiator (draw the graph forward), but it is not the only scheduler.

**Phase 4 — memory + skills + cost visibility:** the memory seam (events + message kinds) and the `skill` loader tool are reserved in the schema now, implemented as tools + a pluggable index later; step usage is persisted and cost-down choices become visible.

Treat each phase as a waypoint, not the target. The target stays the five differentiators above; the milestone shape changes as the engine becomes usable, not as the design drifts.

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

### 1. Declarative DAG scheduling — not a literal script

DAG is how we **schedule subagents**, and it is **declarative, not literal**.

- The user declares **dependencies** (`dependsOn: [nodeId]`) and the graph shape; the runtime derives execution order (topo sort), readiness, and wakeups. The user does not write an imperative script of "spawn A, wait, spawn B".
- A node = one subagent delegation. Edges = declared dependencies. Execution = ready queue + event wakeup, **no join blocking**, so the main flow is not held up by the slowest node.
- It is **not a literal transcript** of what happened (each node is a delegation, not a play-by-play of a model turn) and **not a retrospective graph** recorded after the fact (codex's `agent-graph-store` is a recorded lineage, not a schedule). We draw the graph forward, in advance.
- Contrast: codex spawns subagents from a **model driving a single turn** and only records the resulting graph afterward; opencode uses a single-layer BackgroundJob; claude code uses asyncRewake. None of them treat the graph as a declarative schedule. That is our real space.
- **Key tradeoff DAG unlocks:** each node can pick its own model (see #4), so you can fan out cheap subagents and spend the expensive model only at decision points.

### 2. Long-horizon work — agents that keep working

An agent must be able to **work for a long time** without the user babysitting it, and **survive restarts**.

- Durable state everywhere: the append-only session log, the admission inbox, and completed event boundaries are persisted so a turn can be resumed after a crash/restart.
- Background / continuable child semantics: a subagent can be left running, its result **promoted back** on completion, and a `task_id` can resume it.
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
- Three-level skill disclosure (metadata → SKILL.md → references/scripts).
- Deterministic command hooks + LLM-decision prompt hooks.
- Widened plugin registration surface: tools + agents + commands + hooks + providers, plus Codex-style declarative resource packages (skills / mcp / apps).

## Workspace Awareness

The runtime treats **AGENTS.md as an ambient, model-visible context source** — the same way project instructions shape behavior. Requirements:

- The runtime discovers **workspace AGENTS.md** (and upward-project ones) automatically, starting from the session location.
- A workspace AGENTS.md is a Context Source: it is observed, checked for changes, and admitted as model-visible context.
- The engine's own AGENTS.md is not privileged over a project's — it is the fallback/default when no project one exists.
- Do not conflate this file (the project-owner's target) with any single `AGENTS.md` semantics bound to one model vendor.
- This file sets the direction for the engine; a workspace AGENTS.md sets the direction for that project's sessions. Both are runtime inputs, not hidden configuration.

## Environment & Tech

- Workspace root: the repo. Default branch is `dev`; `v1` holds archived v1 code.
- Stack: Bun + Effect + Drizzle + SQLite. When the runtime reads AGENTS.md, it treats it as durable model-visible context, not as code it executes.
- **Record core-technology designs in `docs/`**: whenever a core mechanism is designed (a seam, the LLM vocabulary/Route, event-sourcing shape, DAG scheduling, the turn loop, scope isolation, etc.), capture it as a design note in `docs/` alongside the code. `specs/v2/` holds the plan; `docs/` holds the implemented/decision design. Design-first before code: write the concept down, then build. Keep these notes current when the design materially changes.

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

### Schema Definitions (Drizzle)

Use snake_case for field names so column names do not need redefinition as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})
```

## Testing

- Avoid mocks as much as possible; avoid `globalThis.*` unless it is the only option.
- Test actual implementation; do not duplicate logic into tests.
- Tests cannot run from repo root; run from package dirs (e.g. `packages/core`).

## Type Checking

- Always run `bun typecheck` from package directories, never `tsc` directly.

## Current Direction

Per `specs/v2/agent-runtime.md`, the first milestone is a minimal skeleton: the three seams plus a single-session CLI that round-trips a prompt through admission → turn → tool → settlement and restores after restart. That milestone intentionally excludes the butler, DAG, cross-process, and Web UI — but every seam stays pluggable so later work does not force rework. Treat the milestone as a waypoint, not the target.

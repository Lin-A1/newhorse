# newhorse

**Model-agnostic, non-captive agent engine (v2).** An agent runtime that schedules subagents with a declarative DAG, keeps long-horizon work restartable via an append-only event log, and lets cheap models do the cheap work.

Not bound to one model; orchestrate agents with declarative scheduling instead of being orchestrated by another framework's runtime.

> This README is a quick map. The target (north star) lives in `AGENTS.md`; the implemented/decision record lives in `docs/core-technology-notes.md`; the plans live in `specs/v2/`.

## What it is (five differentiators)

| Goal | Status | Where |
|---|---|---|
| 1. Declarative DAG scheduling — draw the graph forward, runtime topo-executes | Done (API only) | `core/agent/dag.ts`, `runtime/dag-runner.ts` |
| 2. Long-horizon work — restartable sessions, durable log | Done (single-process) | `core/session/*`, `runtime/app.ts` |
| 3. Cost-controlled subagent models — per-node model for cost balance | Done | `runtime/dag-runner.ts` (`resolveNodeModel`) |
| 4. Model-agnostic output quality — one canonical vocabulary, four-axis route | Done | `schema/llm.ts`, `llm/*` |
| 5. Usable + extensible — directory-as-registration, plugin seam, execpolicy floor | Partial (registration done, consumers TBD) | `plugin/*`, `runtime/tools/*` |

## Architecture (dependency direction)

```
schema (leaf) → core / llm → plugin → runtime → cli
```

- **schema** — canonical LLM vocabulary (`LLMRequest`/`LLMEvent`), event shape `(aggregate_id, seq, type, data)`, session/execpolicy types.
- **core** — seam container, event-sourced session, admission inbox, agent turn loop, DAG topology, `Initiator` (trusted caller kind), deny-all execpolicy fallback. Never imports upper layers.
- **llm** — four-axis Route (Protocol / Endpoint / Auth / Framing), three protocols (openai / openai-responses / anthropic), uniform error taxonomy + retry.
- **plugin** — five-kind capability registry + directory discovery (`tools/` `agents/` `commands/` `hooks/` `skills/`).
- **runtime** — `createApp` domain assembly, builtin toolset (read/write/edit/list/search/bash), execpolicy engine, butler tools + session hub, DAG dispatcher.
- **cli** — thin transport: `newhorse [--prompt TEXT] [--provider ...] [--butler]`.

## Quick start

Requires `OPENAI_API_KEY` (for `openai`/`openai-compatible`) or `ANTHROPIC_API_KEY` (for `anthropic`).

```bash
bun install
bun run packages/cli/src/index.ts --prompt "Read package.json and tell me the name" --data-dir ~/.newhorse/data
```

Run tests from package dirs (never repo root):

```bash
cd packages/core && bun test && bunx tsc --noEmit
```

## Key invariants

- **model-visible ⟺ logged**: everything the model sees is in the append-only log first.
- **seam register-as-disposer**: capabilities register through a seam, not `if`/`switch` chains.
- **fail-closed**: no execpolicy → deny-all; no approve gate → `prompt` forbids; interrupted tools settle as `Tool execution interrupted`, never replay silently.

## Known gaps (see `docs/` §17 + `specs/v2/plan.md`)

Current direction: **runtime server first; model-driven orchestration as the main entrance, declarative DAG as the batch/planned form — both on one child-session base.** The child-session base (workspace inheritance + driven child) is **Phase 2, a prerequisite before orchestration** — not M4. Deferred to M4 or later: cross-session effect delivery + full `SessionManager`, fine-grained permissions bootstrap, web fetch / image read / memory tool, plugin TS loading, CLI entry for DAG (Phase 3 has `dag` subcommand). Memory is a *reserved seam* (events + message kind planned in schema; pluggable index), skills discovery works but needs a `skill` loader tool. The `specs/v2/` status lines mark implemented vs deferred.

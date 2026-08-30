# Handoff — newhorse v2 gap-filling (查漏补缺)

> Working note for whoever picks this up next. Up to date as of the last commit on `dev`.

## Objective (closed)

Bring newhorse v2 up against the five AGENTS.md core-differentiator goals by
decomposing into 7 modules, having an independent subagent 锐评 each, fixing every
finding (including feature-level gaps, per user decision "全部修"), then recomposing
and running a **combined cross-module seam review** + **end-to-end smoke test** +
**integrity/cyclical check**. Per the standing workflow rules, each module got an
independent adversarial re-review until "done" (must-fix findings resolved).

All review loops are **closed and pushed to `dev`**. Nothing is in flight.

## Work completed

### Independent per-module re-reviews (7 modules — all closed)

| # | Module | Commit(s) | Severity closed |
|---|--------|-----------|-----------------|
| ① | schema + llm | `ea1f451db` | 3 SHOULD-FIX |
| ② | session / event-sourcing | `9c2b5ddd8` | 2 MUST-FIX |
| ③ | agent turn loop | `10892cf03` | 1 SHOULD-FIX + 1 NIT |
| ④ | plugin registration | `2b7e0d283` + `6e19be69f` | 2 MUST-FIX + 2 SHOULD-FIX |
| ⑤ | runtime / app / hub / butler | `4a2556788` | 1 MUST-FIX + 1 SHOULD-FIX + 2 NIT |
| ⑥ | builtin tools + execpolicy | `164e30e5b` | 2 MUST-FIX + 3 SHOULD-FIX + 1 NIT |
| ⑦ | DAG scheduling | `56ada6f91` | 1 MUST-FIX + 1 SHOULD-FIX |

### Combined cross-module seam review (`9c6bddf97`, 2 real defects)
- **`tools: []` contract fork** (app vs M3.5 §2.3): now discriminated on
  `!== undefined`. `tools: undefined` → plugin + builtin baseline (plugin wins a
  name collision); a non-empty array is an additive override (explicit > plugin >
  builtin, first occurrence wins); an explicit empty array is the
  override-to-zero signifier (no fs hands) — tools are pluggable.
- **DAG subagent builtin-tool deny-all** (goal #3 contradiction): builtin fs tools
  now read `ctx.execPolicy`, so without one the loop fell back to
  `denyAllExecPolicy` and every node action was denied. `runDag` now injects a
  default workspace execpolicy (when the caller does not), rooted in a temp rules
  location keyed by workspace, so a cheap-model node can actually act while
  `.newhorse`/`.git`/credentials stay protected. Caller-supplied execpolicy
  (parent-style auditing) still wins.
- Also: exported `simpleHash` from the execpolicy seam; documented in
  `anthropic.ts` that `request.system` folds into the cacheable system prefix and
  MUST be static (per-turn content belongs in the user message).

### End-to-end smoke test — PASSING
Real CLI round-trip (mock OpenAI-compatible SSE server): admission → turn → tool
execution → settlement → restart, asserting auth header + static system prefix and
durable re-attach across a restart.

### Integrity / cyclical check — CLEAN
- Dep direction is acyclic and downward: `schema` (leaf) → `core`, `llm` → `plugin`
  → `runtime` → `cli`. `core` never imports upper layers (verified by scan).
- No scattered capability registration (`if/switch` on `.kind`); all capability
  flows through the seam (`PluginRegistry.registerDiscovered`/`list`/`register`,
  core `Seam.register`).

## Test baselines (all passing)

| Package | Tests |
|---------|-------|
| core    | 55 |
| runtime | 117 |
| llm     | 28 |
| plugin  | 8 |

Repo-wide `bunx tsc --noEmit` is clean. Run tests from package dirs (never repo root).

## Notes / rules for the next session

- **Push**: `git -c http.version=HTTP/1.1 push origin dev` — `-c` BEFORE `push`.
  Git stderr surfacing as PowerShell `NativeCommandError` is benign; look for
  `dev -> dev`.
- **Multi-line commit messages break PowerShell** — write to a file first then
  `git commit -F <path>` (e.g. `C:\Users\PC\AppData\Local\Temp\newhorse\commit-msg.txt`).
- **Type checking**: run `bunx tsc --noEmit` from the package dir, never `tsc` directly.
- **Cache architecture (stable)**: Anthropic cache anchor = `body.system` (written
  once into the log at `app.ts`). Never inject per-turn variable content at the head.
  OpenAI caches automatically; `include_usage` is **unconditional** (decoupled from
  `cacheControl`).
- Default branch is `dev`; `v1` holds archived v1. Short three-word-ish branch names,
  no type prefixes. Conventional commits `type(scope): summary`.

## What's next (known gaps — mostly M4, intentionally deferred)

The review explicitly confirms these are deferred, not regressions:
- **Cross-session effect delivery / full `SessionManager`** (M4) — currently DAG
  events use `aggregate:"dag"`; sessions are one-shot.
- **Workspace inheritance for child sessions** (`Session.Created.location`) — the
  `hub.spawn` / DAG child location wiring; AGENTS.md discovery + system context do
  not yet reach sub-nodes (M4 SessionManager).
- **Fine-grained permissions / execpolicy 自举** (M4).
- **No web fetch, no image read, no memory tool** (M4).

Relevant design notes live in `docs/core-technology-notes.md` (updated through the
cross-module fixes) and per-mechanism plans in `specs/v2/`.

<p align="center"><strong>newhorse</strong></p>
<p align="center">A local-first programmable AI workspace for project work, personal continuity, and multi-surface agent workflows.</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## Overview

Newhorse is an independent [OpenCode](https://github.com/anomalyco/opencode) fork that extends a coding-agent runtime into a broader work and life environment. The same runtime powers the desktop app, web app, TUI, SDK, automation, models, tools, MCP servers, sessions, and workspaces.

> newhorse is a **personal tool** built by its author for their own workflow habits — a single-owner workspace, not a team product.

Two product profiles share that runtime:

- **Assistant** focuses on project execution: code, files, terminals, research, plans, tasks, and workspaces.
- **Companion** focuses on personal continuity: relationship-aware conversation, confirmed memory, reminders, follow-ups, and proactive plans.

Profiles are not storage boundaries. Persistent content stays isolated by scope and policy: project content remains in project/workspace contexts, while personal and relationship content remains in the personal domain.

## Highlights

### Full agent workspace

- Desktop, browser, and terminal interfaces
- Project sessions, Git worktrees, personal workspaces, tabs, terminals, file review, LSP, and commands
- Multiple foreground and background agents with tool delegation
- MCP servers, skills, plugins, custom commands, and permission controls
- Server-backed dynamic model catalogs filtered by provider availability
- Multi-provider authentication and model preferences without a hard-coded frontend list
- Native code review engine (diff parsing, deterministic file filtering, line-level AI comments)
- Structural code search with ast-grep, and split LSP tools (definition, references, rename, symbols, diagnostics)
- Browser automation tools (agent-browser) for interactive web tasks

### Assistant and Companion

- Immutable session bindings for workspace and profile
- One server-scoped pinned Companion session, reused across projects
- Configurable Companion persona, quiet hours, proactive frequency, and safety context
- Structured memory proposals with explicit accept/reject/forget lifecycle
- Persistent reminders with create, pause, resume, cancel, lease, and idempotent delivery
- Follow-up scheduling and a Companion Plan surface for memory, reminders, and continuity grants
- Daily activity summaries: one LLM-generated recap per day across your newhorse work, newhorse, Claude Code, and Codex sessions, auto-generated once after 23:00 local
- Todo-continuation enforcer: automatically resumes work when open todos remain after a turn
- Multi-model fallback chains: switch to an available provider/model when the primary one fails
- Automatic permission acceptance with session, lineage, and directory precedence

### Content isolation and trust

- Structured SQLite memory with scope, provenance, status, expiration, and profile/workspace bindings
- Project content does not flow into personal or relationship memory
- Relationship memory does not flow into project contexts
- Only policy-approved global preferences can be projected into work contexts
- Personal workspaces retain the full programming toolset; risky behavior is controlled by explicit policy
- External MCP, plugin, and skill loading in personal contexts is opt-in

## Architecture

Newhorse separates responsibilities that are often conflated in agent products:

| Layer | Responsibility |
| --- | --- |
| Runtime | Sessions, models, agents, tools, MCP, skills, memory, scheduling |
| Orchestration | Delegation across foreground/background agent groups |
| Workspace | Project, worktree, personal environment, and execution location |
| Content scope | Ownership and persistence domain for durable information |
| Policy | Permissions, extension loading, and cross-domain information flow |
| Profile | Assistant/Companion experience, persona, memory behavior, and proactivity |

Important packages include:

- `packages/opencode` — CLI, server, runtime, sessions, tools, worktrees, policy, memory, reminders, and HTTP APIs
- `packages/app` — SolidJS product UI and Playwright suite
- `packages/desktop` — Electron desktop host and installers
- `packages/tui` — terminal interface
- `packages/sdk/js` — generated and handwritten JavaScript/TypeScript SDK surfaces
- `packages/ui` and `packages/session-ui` — shared UI and session components
- `packages/web` — marketing/documentation site, not the product web client

## What newhorse adds on top of OpenCode

Newhorse keeps the OpenCode runtime as its base and layers newhorse-specific capabilities on top — personal continuity, deterministic tooling, and production hardening:

**Memory & personal continuity**
- Structured SQLite memory with scope/provenance/status/expiration and an accept/reject proposal lifecycle (Memory Center)
- Post-turn auto-extraction of memory proposals (review-gated) with same-batch dedup
- FTS5/BM25 retrieval plus entity extraction & boost — no embedding model required
- Persistent reminders, follow-ups, continuity grants, and Companion Plan
- Daily activity summaries across newhorse, Claude Code, and Codex sessions, including archived (non-deleted) sessions
- Observable memory extraction: every auto-extraction gate logs its skip reason, so a Companion session that never proposes memories is diagnosable
- "Clear chat history" on a Companion session clears the displayed chat and background-compacts the conversation into hidden context — continuity is kept without showing the compacted content
- Todo-continuation enforcer (auto-resume on idle with open todos)

**Deterministic tooling & agents**
- Native code-review engine (exact diff, deterministic file filtering, line-level AI comments, falsify-filter)
- ast-grep structural search/replace; split LSP tools (definition/references/rename/symbols/diagnostics)
- MultiEdit batch editing; browser automation (agent-browser, on-demand)
- Multi-model fallback chains with availability-aware resolution
- Execution-phase plugin hooks (permission decisions, end-of-turn continuation)
- Cross-session plan resume (boulder-state)

**Trust & safety**
- Central trust policy with content-free audit; content-scope isolation across project/personal/relationship
- Sensitive-content rejection and memory-policy gating
- Execution-phase permission decisions exposed to plugins

**Desktop & product**
- Tray-resident background mode with a close-action choice (quit vs minimize to tray)
- Tool descriptions localized to Chinese
- Native code review surfaced in the app's review tab
- Deleted sessions keep their token/cost contribution in the usage stats via a `session_usage` archive table and the `/session/usage` endpoint; the usage tab merges active and archived usage
- Companion session rename: the pinned Companion session can be renamed and the header keeps the custom title

**Self-awareness & docs**
- Agent identity: the system prompt presents the agent as newhorse, and a built-in `newhorse-capabilities` skill answers "what can newhorse do" from a bundled checklist instead of fetching external docs
- The built-in configuration skill is now `customize-newhorse`, documented against newhorse config paths (newhorse.json, .newhorse, ~/.config/newhorse); opencode paths are marked legacy

Several of these are ported from or inspired by open-source reference projects (OpenCodeReview, oh-my-opencode, mem0, and Claude Code's formats), respecting their licenses.

## Current status

Newhorse is under active development. Source builds, local web and desktop development, portable CLI exports, and unsigned desktop installer builds are supported. No package-manager release or signed public installer is currently published.

Major foundations already implemented include:

- Central trust policy and content-free policy audit
- Assistant/Companion profiles and personal workspaces
- Structured memory, reminders, follow-ups, continuity grants, and Companion Plan management
- Daily activity summaries (session readers, 23:00 scheduler, HTTP list/generate, sidebar timeline), including archived (non-deleted) sessions
- Server-backed dynamic model/provider catalogs
- Legacy and v2 settings layouts
- Memory retrieval upgrades: FTS5/BM25 search, entity extraction + boost, and post-turn auto-extraction (review-gated)
- Execution-phase plugin hooks (permission decisions, end-of-turn continuation)
- Tray-resident desktop mode (close-to-tray keeps the server and background agents running)
- Tool descriptions localized to Chinese
- Linux and Windows portable CLI export
- Windows NSIS and Linux desktop packaging paths
- newhorse identity and capability self-awareness (system prompt presents the agent as newhorse; built-in `newhorse-capabilities` skill)
- Built-in `customize-newhorse` skill replaces `customize-opencode` (newhorse config paths; opencode paths marked legacy)
- Usage archiving: deleting a session no longer erases its token/cost from the usage stats (session_usage archive table + /session/usage endpoint; usage tab merges active and archived usage)
- Observable memory extraction (per-gate skip-reason logging)
- Companion "clear chat history" = optimistic clear + hidden background compaction (continuity kept)
- Companion session rename

Daily summaries are live in the sidebar timeline. A broader unified Today/daily-entry experience remains intentionally deferred. macOS desktop validation and production signing/notarization are still release-gating items.

## Environment requirements

- [Bun](https://bun.sh) 1.3.x
- Git
- Platform-specific build tools required by Electron Builder

## Build from source

```bash
git clone https://github.com/Lin-A1/newhorse.git
cd newhorse
bun install

# CLI/server development
bun run --cwd packages/opencode dev

# Product web UI hot reload
bun run dev:web

# Electron desktop development
bun run dev:desktop
```

The product web UI is served by the Newhorse CLI/server. `packages/web` is a separate marketing and documentation site.

## Product commands

The root product orchestrator delegates to package scripts and tracks target readiness and artifact fingerprints:

```bash
bun run product targets [--json]
bun run product doctor [--target <id>]
bun run product web [--source]
bun run product dev <cli|web|desktop>
bun run product build [--product cli|desktop|all] [--target <id>]
bun run product export [--product cli|desktop|all] [--target <id>] [--execution local|ci|auto] [--force]
bun run product verify --artifact <path>
```

Target state uses strict meanings:

- **configured** — build configuration exists
- **exportable** — a local or CI export path exists
- **verified** — the artifact has run successfully on the target OS
- **signed** — platform signing/notarization is complete
- **releasable** — the artifact is verified, signed, and authorized for release

A successful local package build is not automatically treated as signed or releasable.

## Testing

Run package-scoped commands from the package directory, not the repo root.

```bash
bun run --cwd packages/app typecheck
bun run --cwd packages/opencode typecheck
bun run --cwd packages/opencode test
bun run --cwd packages/opencode test:httpapi
```

## Contributing

See `README.zh.md` for the Chinese version. For code changes, keep commits focused and prefer small, reviewable patches.
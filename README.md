<p align="center">
<pre>
██      ██  ██████████  ██      ██  ██      ██  ██████████  ████████    ██████████  ██████████
████    ██  ██          ██      ██  ██      ██  ██      ██  ██      ██  ██          ██
██  ██  ██  ████████    ██  ██  ██  ██████████  ██      ██  ██████      ████████    ████████
██    ████  ██          ████  ████  ██      ██  ██      ██  ██  ██              ██  ██
██      ██  ██████████  ██      ██  ██      ██  ██████████  ██    ██    ██████████  ██████████
</pre>
</p>

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
- Custom providers support three wire protocols — OpenAI Completions, OpenAI Responses, and Anthropic Messages — with a one-click "Fetch models" button that discovers the provider's model list from its `/models` endpoint
- Provider balance/credit checking (OpenRouter `/api/v1/credits`, DeepSeek `/user/balance`) surfaced in Settings → Providers, backed by built-in trusted templates rather than a user-script sandbox
- Native code review engine (diff parsing, deterministic file filtering, line-level AI comments)
- Structural code search with ast-grep, and split LSP tools (definition, references, rename, symbols, diagnostics)
- Browser automation tools (agent-browser) for interactive web tasks

### Assistant and Companion

- Immutable session bindings for workspace and profile
- One Companion session pinned to a personal workspace, decoupled from whichever project is currently open
- Configurable Companion persona, quiet hours, proactive frequency, and safety context
- Structured memory with no-approval lifecycle: extracted and tool-saved memories apply immediately, and stay editable/deletable in the Memory Center
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
- Structured SQLite memory across four content scopes — project / personal / relationship / user-global — with provenance, status, and expiration (Memory Center)
- Auto-extraction applies immediately (no manual accept/reject): extracted and tool-saved memories become active directly, and stay editable/deletable in the Memory Center
- Extraction classifies memory into project context vs user-global preference, so project instructions stay project-scoped and are never promoted into cross-project preferences
- Both Companion and work sessions get memory injected into context (Companion: relationship memories; work: project/user-global memories), not just on-demand tool lookup
- Memory writes honor the agent's effective permission (a denied `memory.save` also blocks auto-extraction), and tool/extraction saves pass the effective ruleset to the trust policy
- Prompt caching is prefix-friendly: the stable system prompt (identity/env/instructions/skills/persona) is cached as a segment; dynamic memory/continuity lives in a separate post-breakpoint segment, so memory changes don't invalidate the cached prefix
- FTS5/BM25 retrieval plus entity extraction & boost — no embedding model required
- Persistent reminders, follow-ups, continuity grants, and Companion Plan
- Daily activity summaries across newhorse, Claude Code, and Codex sessions, including archived (non-deleted) sessions; visible in the session right-side panel and sidebar, with a generate-now button and an agent query tool
- A dedicated daily report page (`/daily`) renders each day as a structured, deliverable report — an AI overview plus deterministic work output (files/additions/deletions), per-session detail with todo status, and usage/cost rollup
- Every day's summary is recorded and retained: the daily-summary store is date-keyed, auto-generated each day past 23:00 (with one-day backfill), and the timeline lists the full history
- Companion tone is example-driven (short instruction + five Chinese few-shot dialogues covering small talk/help/emotion-first/uncertainty/humor) with a behavioral default persona, not rule-stacking
- Observable memory extraction: every auto-extraction gate logs its skip reason, so a session that never proposes memories is diagnosable
- "Clear chat history" on a Companion session clears the displayed chat and background-compacts the conversation into hidden context — continuity is kept without showing the compacted content
- Todo-continuation enforcer (auto-resume on idle with open todos)
- Memory Center has an "all workspaces" aggregate view: read-only, grouped by workspace, listing every workspace's project/personal memories plus user-global preferences (relationship memories stay gated to the current profile — cross-workspace read never leaks isolation)
- The memory tool is fully self-service: agents can `save`, `forget`, `archive`, `clear`, `consolidate`, and now `update` (in-place content/kind correction that keeps the id and provenance) — so models can keep durable memory accurate without user trips to the Memory Center
- Memory extraction is throttled (5 min per session) and importance-gated: the LLM rates every proposal high/medium/low and low-rated facts are dropped before they can occupy a durable slot, so a chatty session cannot crowd out genuinely important memories with trivial chatter (a soft daily cap is a backstop, not the primary guard). Extraction runs with prompt-cache writes disabled — the background prompt shares the session cache key but never matches the main prefix, so writing a cache breakpoint there would evict the main conversation's cached prefix (previously dropped cache-hit rates toward 40%); dates were also moved out of the cached stable system prefix so a day rollover no longer invalidates the whole cache

**newhorse workbench (Companion-only)**
- A dedicated workbench page (`/workbench`) is the newhorse "butler" hub: a presence strip, personal todos, the full daily-summary history, and usage stats in one place
- Workbench v2 layout: the 90-day contribution heatmap spans full width on top, with a two-column body (presence + todos | usage + daily-summary timeline) that collapses to a single column on narrow screens; scroll position is preserved across data refreshes so the page never jumps back to the top
- Real presence sensing: on desktop the host reports the actual foreground app, lock state, and meeting state (Win32 foreground-window probe, request-driven with a 15s cache — no resident daemon); the server exposes a `POST /presence` endpoint backed by an in-memory ref so LAN/mobile clients read the same live signal, while web falls back to session-derived idle time
- Personal workbench todos: user-created or newhorse-proposed (`workbench` tool), with a status state machine (open → in_progress → done/cancelled), priorities, deadlines, and per-directory isolation
- Companion context injects the current open todos (top 5 by priority) so newhorse can act on them conversationally
- Workbench entries are Companion-only: the fixed titlebar tab and the home sidebar entry are hidden inside work (assistant) sessions
- Session titles refresh automatically: default-named sessions get retitled from the recent conversation every N turns (configurable `experimental.session_title_refresh_interval`); user-renamed titles are never overwritten

**Deterministic tooling & agents**
- Native code-review engine (exact diff, deterministic file filtering, line-level AI comments, falsify-filter)
- ast-grep structural search/replace; split LSP tools (definition/references/rename/symbols/diagnostics)
- MultiEdit batch editing; browser automation (agent-browser, on-demand)
- Multi-model fallback chains with availability-aware resolution, plus a per-provider circuit breaker (three-state, consecutive-failure/error-rate criteria, half-open probe) that skips broken providers in the chain and fails fast instead of waiting out timeouts
- Four-mode self-dispatch: `researcher`/`writer` are delegatable (`task`), with a subagent_meta delegation table injected into the stable system prompt and a `plan_enter` tool for the build agent to hand off into plan mode; spawned subagents cannot delegate further (task is force-denied), and delegation depth is monotonic (a persisted header blocks resume bypasses)
- Execution-phase plugin hooks (permission decisions, end-of-turn continuation)
- Cross-session plan resume (boulder-state)
- Tool stability hardening: unavailable tool calls produce one explicit model-visible failure instead of an `invalid` retry loop; the legacy per-message `tools` map can no longer deny the whole toolset; PowerShell subprocess output is forced to UTF-8 on Windows
- Context compaction is presentation-friendly: a compaction renders as a single collapsed marker ("compacted · N messages / M tokens") that expands to the model summary — the checkpoint payload never shows as plain assistant output, and the compacted conversation stays scrollable above; the summarization directive is sent as the FINAL user message (prefix-cache friendly). While the summary turn is still in flight the marker shows a compacting spinner instead of appearing late; counts (messages/tokens) are computed from the compacted span, and the marker only expands via its chevron (no accidental toggle on body clicks)
- Work-link trajectory visualization and cache metrics: each session gets a trajectory timeline (turn boundaries, tool calls with input/output/error highlight, subagent rows) that jumps back to the originating message; a context meter shows system/tools/messages breakdown with projected next-turn tokens, and the stats row shows the live cache-hit rate (`cacheRead / (input + read + write)`) — all projected from the session usage archive
- Goal system (first-class): a `goal` table + service state machine (open → in_progress/blocked → done/cancelled) with a `goal` tool, plan-file association, and a mandatory `done_reason` audit before a goal can be marked done
- Todo-continuation cap: background auto-resume stops after `experimental.todo_continuation_max_iterations` (default 100), user activity cancels pending injections via a 2s countdown, and a message-level abort check backs up the existing event-based abort detection
- Crash recovery and session invariants: a repair pass closes dangling interrupted turns (synthesizing tool/result failures with "retry only idempotent tools" guidance) before any message load or resume, and the core append path validates event seq/step/tool-pairing invariants with two-phase staging so invalid events never persist
- Prompt-cache hardening: intermediate breakpoints on long histories (every ~40 messages, capped inside the provider limit) so an evicted prefix re-sends one window instead of the whole log; MCP instruction blocks are deterministically sorted so reconnects never reshuffle the cached prefix; oversized tool outputs are truncated to 50k chars before entering the model context (full output stays in the session log); multi-step turns accumulate token usage across tool rounds instead of keeping only the last step
- Memory extract and other background LLM calls run with cache writes disabled so they cannot evict the main conversation prefix

**Trust & safety**
- Central trust policy with content-free audit; content-scope isolation across project/personal/relationship
- Sensitive-content rejection and memory-policy gating
- Execution-phase permission decisions exposed to plugins

**Desktop & product**
- Tray-resident background mode: a Chinese close-action dialog (minimize to tray vs quit, rememberable choice); minimize always goes to the taskbar — only closing parks the window in the tray
- Agent selector in the composer widened (min 180 / panel 360) with two-line name + description, no truncation
- Add-server dialog keeps inputs editable during health checks (no more input freeze)
- Tool descriptions localized to Chinese
- Native code review surfaced in the app's review tab
- LSP tools reachable out of the box; follow (change watching) and browser automation (first-use auto-download) fully wired
- Usage stats are accurate and live: token/cost figures come directly from each provider's usage report (normalized to fresh-input semantics for all protocols), not from proxy-side estimation; deleted sessions keep their contribution via a `session_usage` archive table; the tab pages through the full session list (no 1000-row cutoff), includes archived sessions, and auto-refreshes on an interval and on window focus; the session context panel's cost / cache-hit-rate / context figures refresh in place after every step-finish via a published `session.updated` event
- Companion session rename: the pinned Companion session can be renamed and the header keeps the custom title
- Mobile/multi-device access reuses the web app: bind `0.0.0.0` (`--hostname 0.0.0.0` or mDNS), authenticate via `OPENCODE_SERVER_PASSWORD` (mandatory on the LAN — the server refuses to bind all interfaces without one) or the `auth_token` URL, and install the page as a PWA (manifest + network-only service worker so auth-protected responses are never cached)
- The desktop LAN settings panel lists only reachable addresses: VPN/TUN/link-local interfaces (172.16-31.x, 198.18.x, 169.254.x, CGNAT 100.64.x) are filtered out so the copyable URL is the actual WLAN IP, and a Windows Firewall inbound rule is auto-added for the LAN port
- LAN access is configurable from the desktop settings panel ("局域网/手机访问"): a toggle (loopback + random password when off, `0.0.0.0` + your password when on — off is refused without a password), the network URL with a copyable `auth_token` link, and port/password configuration persisted to the app store
- Mermaid renders inline in the conversation: ```mermaid code blocks become SVG diagrams (v11) with a refined theme that follows the active UI palette (light/dark each get their own colors, with a light-purple fallback), the TUI renders them as ASCII, failures fall back to a copyable code block, and a copy-source entry point is always available
- Session side panel tracks background subagent tasks (running/completed/error) with an all-complete toast batch notification
- TUI markdown auto-continuation: Enter after `1. text`, `- item`, `> quote`, or tab-indented lines continues the list/quote/indent (`2. `, same bullet, `> `, tab); an empty list item exits the list instead of leaving a stray prefix

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
- Structured daily report page (`/daily`): AI overview + deterministic work output, per-session detail with todos, and usage/cost rollup, stored as a versioned JSON report with backward-compatible rendering of older plain-text summaries
- Server-backed dynamic model/provider catalogs
- v2-only layout (the legacy interface and its retirement migration were removed)
- Memory retrieval upgrades: FTS5/BM25 search, entity extraction + boost, and post-turn auto-extraction that applies immediately (no approval gate)
- Memory layering: four content scopes (project / personal / relationship / user-global) with automatic migration of existing memories
- Memory no-approval: extracted and tool-saved memories become active directly; Memory Center is edit/delete/pause, with per-scope labels and no accept/reject step
- Work-session memory injection: assistant sessions get project/user-global memories in context, not just on-demand tool lookup
- Memory permission honored end-to-end (denied `memory.save` blocks auto-extraction too); Memory Center visibility fixed via a personal-scope migration
- LSP / follow / browser automation wired end-to-end (were unreachable dead chains), with first-use auto-download for the browser binary
- Continuity auto-proposes after companion/assistant turns (approval still required before injection)
- Proactive care auto-triggers when enabled: idle check-in with a dynamic body composed from the daily summary and recent memories, respecting quiet hours and frequency caps
- Prompt caching is prefix-friendly (stable system cached; dynamic memory/continuity in a separate post-breakpoint segment)
- Companion tone is example-driven with a behavioral default persona
- Execution-phase plugin hooks (permission decisions, end-of-turn continuation)
- Tray-resident desktop mode with a Chinese close-action dialog (minimize to tray vs quit, rememberable); minimize always goes to the taskbar
- Agent selector UI polish (composer dropdown widened, two-line entries) and add-server dialog input-freeze fix
- Tool descriptions localized to Chinese
- Linux and Windows portable CLI export
- Windows NSIS and Linux desktop packaging paths
- newhorse identity and capability self-awareness (system prompt presents the agent as newhorse; built-in `newhorse-capabilities` skill)
- Built-in `customize-newhorse` skill replaces `customize-opencode` (newhorse config paths; opencode paths marked legacy)
- Usage stats are accurate and live: deleted sessions keep their token/cost via a `session_usage` archive table; the tab pages through the full session list (no cutoff), includes archived sessions, and auto-refreshes on an interval and on window focus
- Observable memory extraction (per-gate skip-reason logging)
- Companion "clear chat history" = optimistic clear + hidden background compaction (continuity kept)
- Companion session rename
- Memory Center "all workspaces" aggregate view (read-only, grouped by workspace; relationship rows gated to the current profile)
- newhorse workbench (`/workbench`, Companion-only): presence strip, personal todos (user + newhorse-proposed), full daily-summary history, and usage stats; fixed titlebar tab + home sidebar entry hidden in work sessions
- Automatic session-title refresh for default-named sessions (configurable interval; user titles never overwritten)
- Context compaction marker: single collapsed row that expands to the summary — checkpoint payload never rendered inline
- Mobile/multi-device access: LAN binding with mandatory password, auth_token URL, and PWA install (network-only service worker)
- Four-mode self-dispatch (researcher/writer delegation, subagent_meta delegation table, plan_enter, delegation permission sink, monotonic depth)
- Per-provider circuit breaker in the fallback chain + fail-fast on explicitly routed open circuits
- Tool stability hardening (no `invalid` retry loop; legacy tools map cannot deny-all; PowerShell UTF-8 output)

Daily summaries are live in the sidebar timeline, and a full structured daily report is available at the `/daily` page. macOS desktop validation and production signing/notarization are still release-gating items.

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
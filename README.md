<p align="center"><strong>newhorse</strong></p>
<p align="center">A local-first programmable AI workspace for software projects, personal work, and long-term continuity.</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## Overview

Newhorse is an independent [OpenCode](https://github.com/anomalyco/opencode) fork that expands a coding-agent runtime into a unified work-and-life AI environment. The same client/server runtime powers the desktop app, web app, TUI, SDK, automation, models, tools, MCP servers, sessions, and workspaces.

Two product profiles share that runtime:

- **Assistant** focuses on project execution: code, files, terminals, research, plans, tasks, and workspaces.
- **Companion** focuses on personal continuity: relationship-aware conversation, confirmed memory, reminders, follow-ups, and proactive plans.

Profiles are not storage boundaries. Persistent content is isolated by scope and policy: project content remains in project/workspace contexts, while personal and relationship content remains in the personal domain. A profile never grants permission to move content across that boundary.

## Highlights

### Full agent workspace

- Desktop, browser, and terminal interfaces
- Project sessions, Git worktrees, personal workspaces, tabs, terminals, file review, LSP, and commands
- Multiple foreground and background agents with tool delegation
- MCP servers, skills, plugins, custom commands, and permission controls
- Dynamic model catalog from the server, filtered by provider connection and availability
- Multi-provider authentication and model preferences without a hard-coded frontend catalog

### Assistant and Companion

- Immutable session bindings for workspace and profile
- One server-scoped pinned Companion session, reused across projects instead of creating a new conversation per directory
- Configurable Companion persona, quiet hours, proactive frequency, and safety context
- Structured memory proposals with explicit accept/reject/forget lifecycle
- Persistent reminders with create, pause, resume, cancel, lease, and idempotent delivery semantics
- Follow-up scheduling and a Companion Plan surface that combines proposed memory, reminders, and continuity grants
- Automatic permission acceptance with session, lineage, and directory precedence plus directory-specific response routing

### Content isolation and trust

- Structured SQLite memory with scope, provenance, status, expiration, and profile/workspace bindings
- Project content does not flow into personal or relationship memory
- Relationship memory does not flow into project contexts
- Only policy-approved global preferences can be projected into work contexts
- Personal workspaces retain the complete programming toolset; risky behavior is controlled by explicit `ask` and `deny` policy rather than by removing capabilities
- External MCP, plugin, and skill loading in personal contexts is subject to opt-in policy

## Architecture

Newhorse separates the responsibilities that are often conflated in agent products:

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

## Current status

Newhorse is under active development. Source builds, local web/desktop development, portable CLI exports, and unsigned desktop installer builds are supported. No package-manager release or signed public installer is currently published.

The following major foundations are implemented:

- Central trust policy and content-free policy audit
- Assistant/Companion profiles and personal workspaces
- Structured memory, reminders, follow-ups, continuity grants, and Companion Plan management
- Dynamic server-backed model/provider catalogs
- Legacy and v2 settings layouts
- Linux and Windows portable CLI export
- Windows NSIS and Linux desktop packaging paths

The unified Today/daily-entry experience remains intentionally deferred. macOS desktop runtime verification and production signing/notarization remain release-gating work.

## Requirements

- [Bun](https://bun.sh) 1.3.x
- Git
- Platform tooling required by the target you build (Electron Builder reports missing prerequisites)

## Build from source

```bash
git clone https://github.com/Lin-A1/newhorse.git
cd newhorse
bun install

# CLI/server development
bun run --cwd packages/opencode dev

# Product web UI with hot reload
bun run dev:web

# Electron desktop development
bun run dev:desktop
```

The product web UI is served by the Newhorse CLI/server. `packages/web` is the separate marketing and documentation site.

## Product commands

The root product orchestrator delegates to package scripts while tracking target readiness and artifact fingerprints:

```bash
bun run product targets [--json]
bun run product doctor [--target <id>]
bun run product web [--source]
bun run product dev <cli|web|desktop>
bun run product build [--product cli|desktop|all] [--target <id>]
bun run product export [--product cli|desktop|all] [--target <id>] [--execution local|ci|auto] [--force]
bun run product verify --artifact <path>
```

Target status has strict meaning:

- **configured** — build configuration exists
- **exportable** — a local or CI export route exists
- **verified** — the artifact actually ran on the target operating system
- **signed** — platform signing/notarization completed
- **releasable** — verified, signed, and separately authorized for publication

A local build is not reported as signed or releasable merely because packaging succeeded.

## Testing

The repository deliberately blocks test discovery from the root. Run tests from the owning package:

```bash
# Backend/runtime
bun test --cwd packages/opencode
bun run --cwd packages/opencode typecheck

# App
bun --cwd packages/app test --preload ./happydom.ts
bun run --cwd packages/app typecheck
bun run --cwd packages/app typecheck:e2e

# Playwright
bun --cwd packages/app run test:e2e

# Repository-wide typecheck/lint orchestration
bun run typecheck
bun run lint
```

Some app tests require the browser condition or the package's Happy DOM preload; follow the nearest package script when available.

## Packaging

### Portable CLI

```bash
bun run product export --product cli --target windows-x64 --execution local --force
bun run product export --product cli --target linux-x64 --execution local --force
```

Portable outputs are written under `packages/opencode/dist/exports/` with a ZIP, SHA-256 checksum, and manifest. The export command does not publish a release, create a tag, or push a container.

### Windows desktop installer

On Windows:

```powershell
bun run --cwd packages/desktop build
bun run --cwd packages/desktop package:win
```

Electron Builder writes the NSIS installer to `packages/desktop/dist/`. Local installers are unsigned unless the trusted signing environment is explicitly configured. CI desktop exports are available through the manually dispatched artifact-only workflow.

Build structure and manifests are deterministic, but Bun/Electron payloads are not guaranteed to be bit-for-bit reproducible because build metadata can include timestamps and paths. Treat each artifact's own SHA-256 as authoritative.

## Configuration compatibility

Newhorse writes configuration under `.newhorse/` in the project or user home directory. Legacy `.opencode/` paths remain readable for migration compatibility. Runtime environment variables prefer `NH_*` and continue to accept upstream `OPENCODE_*` aliases where compatibility is required, for example `NH_DB` / `OPENCODE_DB`.

## Relationship to OpenCode

Newhorse is an independent fork of [OpenCode](https://github.com/anomalyco/opencode). It is not developed, endorsed, or supported by the OpenCode team. Please report Newhorse issues in this repository rather than upstream.

The original project and this fork remain subject to their applicable licenses. See [LICENSE](./LICENSE).

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Keep tests package-scoped, do not commit credentials or internal handoff documents, and report verification boundaries honestly.

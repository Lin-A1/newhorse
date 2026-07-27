<p align="center"><strong>newhorse</strong></p>
<p align="center">One programmable AI for work and life, with isolated content domains.</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## What Newhorse is

Newhorse is a programmable AI agent that combines assistant and companion capabilities in one experience. It can work with code, files, commands, research, personal tasks, reflection, and reminders without forcing you to switch between separate products.

Assistant and Companion are compatible experience profiles, not isolated applications. They share one runtime and can be used together. The hard boundary is the content domain:

- **Work content** belongs to a project, workspace, or task/transaction context.
- **Personal and relationship content** belongs to the personal domain.
- **Global preferences** may flow into work contexts under policy; project content does not flow into personal or relationship memory, and relationship memory does not flow outward.

A profile controls experience, persona, memory behavior, and proactive features. It does not by itself decide where content is stored.

## Product model

Newhorse separates six concerns:

- **Runtime** provides sessions, models, agents, tools, MCP, skills, memory, and scheduling.
- **Orchestration** lets one entry point delegate to multiple foreground or background agent groups for coding, assistant, and companion work.
- **Workspace** identifies the active project or personal environment.
- **Content scope** determines where persistent information belongs.
- **Policy** controls permissions, extension loading, and cross-domain information flow.
- **Profile** adjusts the Assistant/Companion experience without creating a separate runtime.

Every workspace keeps the full programming toolset. Personal workspaces are not reduced to a limited note-taking mode; risky actions are governed through explicit `ask` and `deny` policy.

## How it differs from OpenCode

Newhorse is built on the engineering foundation of [OpenCode](https://github.com/anomalyco/opencode), but it is pursuing a broader product direction.

### Retained from OpenCode

- Terminal and TUI workflows
- Multi-provider model support
- Coding tools, agents, LSP, MCP, skills, sessions, projects, and worktrees
- Extensible client/server architecture

### Implemented in Newhorse

- Immutable session bindings for workspace and experience profile
- A personal workspace with the same core coding and file capabilities as project workspaces
- Personal-workspace opt-in controls applied before external MCP, plugin, and skill loading
- Structured SQLite memory with workspace/profile scoping, lifecycle states, expiration, and model-inferred proposals that require confirmation
- Assistant and Companion profiles on one runtime, including persona configuration and protected Companion safety context
- Persistent reminders and opt-in proactive messages with pause, quiet-hours, frequency, lease, idempotency, and audit foundations
- Setup commands, typed skill parameters, App/TUI integration, and local portable CLI export for Linux and Windows
- Fork-safe GitHub Actions that avoid upstream-only automation on this repository

### Still being closed out

- A single explicit content-scope policy for project/task versus personal/relationship storage
- Redacted capability-status diagnostics and the complete workspace policy matrix
- Memory management UI, export, correction, and transactional scope clearing
- The complete Companion safety evaluation matrix and relationship reset flow
- Recurring reminders, crash-safe delivery deduplication, and reminder management UI
- Remaining V2 adapters, migration coverage, and release maturity

The repository does not describe these in-progress items as completed features.

## Current status

Newhorse is under active development. Source builds and portable CLI artifacts are supported, but no package-manager release or signed installer is currently published.

The implementation is being completed phase by phase. Existing foundations are retained and tested while security, content isolation, memory management, proactive delivery, and cross-platform distribution are brought to their full acceptance criteria.

## Build from source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/Lin-A1/newhorse.git
cd newhorse
bun install
bun run --cwd packages/opencode dev
```

The repository intentionally prevents running the test suite from the root. Run package-local checks instead:

```bash
bun test --cwd packages/opencode
bun run --cwd packages/opencode typecheck
bun run --cwd packages/app typecheck
bun run typecheck
```

Some frontend tests require browser conditions:

```bash
bun test --conditions=browser --cwd packages/app
```

## Portable CLI export

Create a local portable Windows x64 package without publishing a release:

```bash
bun run --cwd packages/opencode export:local --target windows-x64
```

Other supported targets are `windows-x64-baseline` and `linux-x64`. Outputs are written to `packages/opencode/dist/exports/` as a ZIP, SHA-256 checksum, and manifest. The export path does not publish npm packages, create a GitHub Release, push containers, or create tags.

This is a portable CLI archive, not a signed Windows installer.

## Memory and content isolation

The runtime currently stores structured memory in SQLite. Records carry scope, workspace/profile bindings, provenance, status, and expiration metadata. Model-inferred records enter a `proposed` state rather than becoming trusted facts automatically.

The target storage contract is stricter than a profile switch:

- Project and task content remains in its work scope.
- Personal, life, and relationship content remains in personal scope.
- Only policy-approved global preferences may cross into a work scope.
- Sensitive information remains rejected while encryption, key rotation, backup, and deletion guarantees are not complete.

The remaining domain-enforcement and management work is tracked as active development.

## Profiles and runtime agents

Assistant and Companion are experience profiles within the same intelligent system and may be used compatibly. A single entry point can coordinate parallel agent groups for coding, general assistance, and companion-oriented work. Runtime agents such as **build**, **plan**, and **general** are a different layer: they specialize execution and delegation rather than define a product or storage domain. Agent identity never grants permission to move content between domains.

## Configuration compatibility

Newhorse configuration lives in `.newhorse/` in the project or home directory, and Newhorse-specific environment variables use the `NH_` prefix. Legacy `.opencode/` paths and `OPENCODE_` variables are still read where compatibility is required during migration.

## Relationship to OpenCode

Newhorse is an independent fork of [OpenCode](https://github.com/anomalyco/opencode). It is not built by, endorsed by, or affiliated with the OpenCode team. Please report Newhorse issues in this repository rather than upstream.

The original work and this fork remain subject to their applicable licenses. See [LICENSE](./LICENSE).

## Contributing

Read the [contributing guide](./CONTRIBUTING.md) before opening a pull request.

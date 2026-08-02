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
- Persistent reminders and opt-in proactive messages with pause, quiet-hours, frequency, lease, idempotency, and audit foundations, plus reminder management in App settings (legacy and v2 layouts) and the TUI
- A companion plan review surface that aggregates proposed memory, scheduled reminders, and minimized continuity grants in one place without reading raw session history
- Setup commands, typed skill parameters, App/TUI integration, and local portable CLI export for Linux and Windows
- Fork-safe GitHub Actions that avoid upstream-only automation on this repository

### Still being closed out

- A single explicit content-scope policy for project/task versus personal/relationship storage and the unified Trust Policy enforcement call sites
- Redacted capability-status diagnostics and the complete workspace policy matrix
- The complete Companion safety evaluation matrix and relationship reset flow
- Cross-OS portable CLI verification is done (export-cli validate-linux/validate-windows on target-OS runners); Desktop installer smoke on target runners remains
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

## Unified product commands

A single orchestrator inspects targets, checks the environment, starts the Web entry, runs development hosts, and drives builds, exports, and artifact verification. It only delegates to the existing package scripts and never re-implements bundling or packaging.

```bash
bun run product targets [--json]        # every target with configured/exportable/verified/signed/releasable status
bun run product doctor [--target <id>]   # host + target readiness, including which runners are still required
bun run product web [--source]           # start the product Web entry (nh web)
bun run product dev <cli|web|desktop>    # run a development host
bun run product build [--product cli|desktop|all] [--target <id>]
bun run product export [--product cli|desktop|all] [--target <id>] [--execution local|ci|auto] [--force]
bun run product verify --artifact <path> # static checks: existence, size, sha256
```

Exports are incremental. The orchestrator records an input fingerprint (relevant source, lockfile, config, Bun version, target, version) per target and skips the build when inputs and the previous artifacts are unchanged. Pass `--force` to rebuild regardless, or change any of the fingerprinted inputs (a source edit, `bun install`, a version bump) to invalidate the cache.

Status values are intentionally strict:

- **configured** — code and configuration exist.
- **exportable** — a local or CI export path exists.
- **verified** — the artifact actually ran on a target-OS runner.
- **signed** — code-signed and/or notarized.
- **releasable** — verified, signed, and separately authorized.

Targets that cannot be honestly verified on this host are reported as such (`doctor` prints the missing runner) instead of being silently treated as ready.

## Run the Web entry

The product Web UI is started with the CLI, which also runs the local server:

```bash
bun run product web
# or, from source:
bun run --cwd packages/opencode dev web
```

For UI development with hot reload, run the Vite dev server (this requires a separate server):

```bash
bun run product dev web
```

`packages/web` is the marketing/documentation site, not the product Web UI.

## Portable CLI export

Create a local portable package without publishing a release:

```bash
# unified entry
bun run product export --product cli --target linux-x64 --execution local

# direct package script (same output contract)
bun run --cwd packages/opencode export:local --target windows-x64
```

The officially exportable CLI targets are `linux-x64`, `windows-x64`, and `windows-x64-baseline`. All three have been produced and runtime-verified on target-OS runners via the `export-cli` workflow: `linux-x64` by the `validate-linux` job on an ubuntu runner (and directly on a Linux host), and `windows-x64`/`windows-x64-baseline` by the `validate-windows` job on Windows runners (`nh`/`nh.exe` answer the version and setup help). Outputs are written to `packages/opencode/dist/exports/` as a ZIP, SHA-256 checksum, and manifest. The export path does not publish npm packages, create a GitHub Release, push containers, or create tags.

This is a portable CLI archive, not a signed Windows installer. Desktop installers (Windows NSIS, macOS DMG/ZIP, Linux AppImage/DEB/RPM) must be built and verified on their own operating systems; no signed or published release exists yet.

For desktop installers that need tools not present on a local machine, run the `export-desktop` GitHub Actions workflow (manual `workflow_dispatch`, artifact-only): the Linux job installs `rpm` on the runner and produces AppImage/DEB/RPM, the Windows job produces the NSIS installer, and the macOS job produces DMG/ZIP. All three were produced successfully on 2026-08-02; the outputs are unsigned, and signing and notarization require a macOS/Windows runner with credentials. This is the CI path for the RPM, Windows-installer, and macOS targets; `bun run product doctor` prints the local unblocking commands.

**Reproducibility boundary:** the export/verify contract is deterministic in structure — the manifest schema, single-root-binary ZIP layout, and per-artifact SHA-256 checksums are consistent. The binary *payload* is not bit-for-bit reproducible across identical-input rebuilds because the Bun compiler embeds build metadata (timestamps/paths). Treat the per-artifact hash as authoritative for that build, not as a cross-rebuild fingerprint.

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

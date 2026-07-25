<p align="center">newhorse</p>
<p align="center">An AI coding agent with structured long-term memory.</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

### What this is

newhorse is an AI coding agent that runs in your terminal. It reads and writes
code, runs commands, and keeps a persistent memory of your preferences, your
project's context, and the feedback you've given it — so you don't have to
repeat yourself in every new session.

It is a fork of [opencode](https://github.com/anomalyco/opencode), extended with
a structured memory layer and workspace isolation. See
[Relationship to opencode](#relationship-to-opencode).

### Status

Early development. There are no published packages or install scripts yet — build
from source.

### Building from source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/Lin-A1/newhorse.git
cd newhorse
bun install
bun run --cwd packages/opencode dev
```

To run the test suite:

```bash
bun test
```

### Memory

newhorse maintains a file-based memory across sessions, organized into four
kinds of records:

- **user** — your role, goals, and working preferences
- **feedback** — guidance you've given, including what worked and what to avoid
- **project** — context behind the current work that isn't derivable from code
- **reference** — pointers to external systems where information lives

Memory is scoped per workspace. Global preferences flow into a workspace, but
workspace-specific records never leak outward. Records the model infers on its
own are stored as proposals rather than facts, so nothing is silently treated as
established truth.

### Agents

Two built-in agents, switchable with `Tab`:

- **build** — full-access agent for development work
- **plan** — read-only agent for analysis and exploration; denies edits by
  default and asks before running commands

A **general** subagent handles complex searches and multistep tasks. Invoke it
with `@general` in a message.

### Configuration

Configuration lives in `.newhorse/` in your project or home directory, and
environment variables use the `NH_` prefix. The legacy `.opencode/` directory and
`OPENCODE_` variables are still read for compatibility.

### Relationship to opencode

newhorse is an independent fork of
[opencode](https://github.com/anomalyco/opencode) and is not built by, endorsed
by, or affiliated with the opencode team. Please direct issues with newhorse to
this repository rather than upstream.

The original work remains under its own license — see [LICENSE](./LICENSE).

### Contributing

See [contributing docs](./CONTRIBUTING.md) before opening a pull request.

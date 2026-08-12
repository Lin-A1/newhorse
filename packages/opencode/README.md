# newhorse (packages/opencode)

The newhorse CLI, server, and runtime. This package exposes the `nh` binary,
serves the HTTP API, and hosts the session runtime, tools, memory, reminders,
trust policy, and daily summaries that the web app, desktop app, and TUI
connect to.

## `nh` commands

`nh` is the product CLI entry point:

| Command | Purpose |
| --- | --- |
| `nh web` | Start the server and open the web interface |
| `nh serve` | Start the HTTP API server |
| `nh run` | Run a one-off task or interactive session |
| `nh models` / `nh providers` | List models and providers |
| `nh mcp` / `nh agent` / `nh plugin` | Manage MCP servers, agents, and plugins |
| `nh session` / `nh pr` / `nh github` | Session and repository workflows |
| `nh export` / `nh import` | Export and import sessions and data |
| `nh db` | Database utilities |
| `nh stats` | Usage statistics |
| `nh setup` / `nh upgrade` / `nh uninstall` | Installation lifecycle |
| `nh debug` | Debugging tools |
| `nh acp` / `nh tui` / `nh attach` | ACP, terminal UI, and attach entry points |

Run `nh <command> --help` for details.

## Development

```bash
bun install
bun run dev    # run the CLI/server from source
```

## Testing

```bash
bun run typecheck
bun test            # package tests
bun run test:httpapi
```

## Source layout

- `src/server/` — HTTP server, routes, handlers, and middleware
- `src/session/` — session runtime and schema (includes reminders)
- `src/provider/` — provider registry, model config, and authentication
- `src/memory/` — structured memory store and lifecycle
- `src/continuity-grant/` — continuity grants for proactive access
- `src/trust-policy/` — central trust policy and audit
- `src/daily-summary/` — daily activity summaries (session readers + 23:00 scheduler)
- `src/agent/` — agent registry and delegation
- `src/worktree/` — Git worktree management
- `src/mcp/` / `src/plugin/` / `src/skill/` — extension loading
- `src/scheduler/` — scheduled and recurring work

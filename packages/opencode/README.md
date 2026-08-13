# newhorse (packages/opencode)

The newhorse CLI, server, and runtime. This package exposes the `nh` binary,
serves the HTTP API, and hosts the session runtime, tools, memory, reminders,
trust policy, and daily summaries that the web app, desktop app, and TUI
connect to.

The runtime identifies itself as **newhorse** in the system prompt and ships
two built-in skills for product self-awareness: `newhorse-capabilities` answers
"what can newhorse do" from the bundled feature list instead of fetching
external docs, and `customize-newhorse` documents how to configure newhorse
itself. Deleting a session archives its token/cost usage to the `session_usage`
table before the row is removed, so usage stats keep the contribution; archived
usage is served by the `/session/usage` endpoint, and daily summaries include
archived sessions.

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
- `src/memory/` — structured memory store and lifecycle (extraction gate logs skip reasons)
- `src/continuity-grant/` — continuity grants for proactive access
- `src/trust-policy/` — central trust policy and audit
- `src/daily-summary/` — daily activity summaries (session readers + 23:00 scheduler)
- `src/agent/` — agent registry and delegation
- `src/worktree/` — Git worktree management
- `src/mcp/` / `src/plugin/` / `src/skill/` — extension loading (built-in `newhorse-capabilities` and `customize-newhorse` skills)
- `src/scheduler/` — scheduled and recurring work

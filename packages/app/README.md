# newhorse app

The newhorse product web UI, built with SolidJS and served by the newhorse
server. The desktop app (`packages/desktop`) hosts this same renderer inside
Electron.

## Development

```bash
bun install
bun run dev    # Vite dev server on http://localhost:3000
```

The UI talks to a newhorse server. By default it connects to
`http://localhost:4096`; override with `VITE_OPENCODE_SERVER_HOST` /
`VITE_OPENCODE_SERVER_PORT`. For a full local run, start the server from
`packages/opencode` (`bun run dev`) or use `bun run dev:web` from the repo root.

## Commands

```bash
bun run typecheck       # TypeScript check
bun run build           # production build to dist/
bun run test:unit       # unit tests (happy-dom)
bun run test:browser    # browser-condition unit tests
bun run test:e2e        # Playwright end-to-end
bun run test:e2e:local  # Playwright against a local backend
```

## End-to-end tests

The Playwright suite launches a real Chromium and mocks the server:

```bash
bunx playwright install chromium
bun run test:e2e:local
bun run test:e2e:local -- --grep "settings"
```

Environment options:

- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (backend address, default `localhost:4096`)
- `PLAYWRIGHT_PORT` (Vite dev server port, default `3000`)
- `PLAYWRIGHT_BASE_URL` (override base URL)

Note: a stale dev server left listening on ports 3000/4096 can be reused by
Playwright and serve stale code. Kill listeners on those ports before running
the suite.

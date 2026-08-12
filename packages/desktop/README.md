# newhorse desktop

Electron desktop host for the newhorse product UI. The renderer is the same
SolidJS app as `packages/app`; the main process boots the newhorse server as a
sidecar and serves the UI.

## Development

```bash
bun install
bun run dev    # electron-vite dev
```

## Build

Build the renderer and package with electron-builder:

```bash
OPENCODE_CHANNEL=beta bun run build
OPENCODE_CHANNEL=beta bun run package:win
```

- `OPENCODE_CHANNEL` defaults to `dev`; `beta` produces the "newhorse Beta"
  product name and writes the `beta.yml` update feed.
- The build fetches the models.dev catalog and platform sidecar binaries, so a
  working network connection (or a local proxy, e.g.
  `HTTPS_PROXY=http://127.0.0.1:7897`) is required.
- Artifacts land in `dist/`: the NSIS installer (`newhorse-desktop-win-x64.exe`),
  the `beta.yml` update feed, and the blockmap.
- Local builds are unsigned; signing runs in CI only.

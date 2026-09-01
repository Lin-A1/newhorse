# Handoff — newhorse v2 → three-platform client (三端客户端落地)

> Working note for whoever picks this up next. Up to date as of `5e9204856` on `dev` (engine mirror `agent-runtime` @ `1ef138b23`, sync `CHECK OK`). Nothing in flight.

## Objective (closed)

Ship the newhorse **client** on three surfaces from ONE artifact, with the
engine upgraded to serve it (user goal: "web 桌面端 手机端…打包一起…功能齐全…
对接好现有全部能力…打好安装包发出 releases").

Delivered and **published**: https://github.com/Lin-A1/newhorse/releases/tag/v0.1.0
(NSIS installer `newhorse_0.1.0_x64-setup.exe`, ~28MB — Tauri 2 shell + compiled
server sidecar + bundled web UI). Engine mirror synced (`sync --check` OK), both
repos pushed.

## Architecture decisions (locked this round — do not relitigate lightly)

1. **One artifact, three surfaces**: the runtime server serves the built web UI
   on the SAME origin (`NEWHORSE_UI_DIR` / packaged `web-dist/` resource).
   Desktop = Tauri shell + sidecar; LAN/mobile = same origin over the network
   (token in localStorage); standalone web = `bun main.ts` with UI env.
2. **Sessions-first IA** (opencode pattern): no feature-page dashboard. Sidebar
   = sessions grouped 今天/昨天/本周/更早 + utility nav (用量/定时/记忆) +
   settings gear (modal). Home = hero (ball + composer + suggestions + recent
   session cards) shown when no session is selected.
3. **Settings layers**: defaults < `~/.newhorse/config.json` (L2, what the UI
   writes) < cli < env. `writeAgentHomeConfig` merges provider PER FIELD (a
   redacted client round-trip must never wipe the stored apiKey — regression
   tested) and strips display-only keys (hasApiKey/apiKeyHint).
4. **Per-session config resolves FRESH at session create** (main.ts calls
   `loadRuntimeSettings` inside sessionConfig) — UI settings changes reach new
   sessions without a server restart.
5. **Durable sessions + lazy re-attach**: `/v1/sessions` reads the
   SessionRegistry over `events.db` (survives restarts); opening an unattached
   session rebuilds its App from the registry row (continue-after-restart
   works, verified in browser).
6. **Ball = the only "emoji"** (user rule: no emoji glyphs anywhere; the ball
   is the assistant's face). EmotionBall v4 = cream sphere + black FILLED
   capsule eyes (asymmetric per mood) + 10 moods with keyframes (receive-nod,
   error flash, done bounce+confetti, thinking orbit ring, interrupted zzz),
   eased blink, NO mouth. `deriveMood()` pure function maps run state → mood.

## Work completed this round (18 commits `7e8a9ea1d..5e9204856`)

| Slice | Commit(s) | What |
|---|---|---|
| Engine: model-relative compaction | `76e7975f4` | `compactLimit()` — explicit threshold > window×2.5cpt×0.6 > 80k fallback; notes §27 (first full compaction design record) |
| Scale-aware constants | `8060d1b60` `f08b327a2` `5e9204856` | maxOutputTokens (anthropic 4096 silent truncation), summarizer timeout+prompt cap scale, tail BYTE budget (deadlocked the window trigger — fixed) |
| Engine client surfaces (S1) | `8bd7041de` | L2 config file, GET/PUT /v1/settings (redacted), GET /v1/models (llm/listModels), interactive approval hub + endpoints, usage aggregation + event `created_at` column, scheduler (定时任务: interval/daily/5-field cron) + endpoints, /v1/memory, ServerHandle.admitPrompt |
| Web core (S2) | `c31b5b133` | apps/web SPA (React18+Vite+Tailwind): chat SSE, session list, settings, usage heatmap, schedules, memory, EmotionBall v1 |
| Desktop (S5) | `848ba5a5a` | Tauri 2 shell: sidecar spawn/wait/kill, engine-config-driven LAN switch, restart_server, NSIS installer; rustup 1.73→1.98 |
| UI v3 rebuild | `059ba8c99` | sessions-first shell, home hero, inline model switcher, settings modal, durable sessions (fixed: restart wiped the list) |
| Visual overhaul | `ebbf261b7` | ball v2, SVG icon set (zero emoji), ambient bg |
| Critique round | `7688b3ee8` `d21485943` `5e9204856` | ball v4 (10 moods/keyframes/confetti), document-flow transcript, codex inline tool rows (verb map 读取/检索/写入/运行/抓取), 思考 rows, 工作中 X 分 X 秒, inline approval card, lazy re-attach, kbd hints, pretty provider errors |

### Bugs found & fixed (each has a repro/test where feasible)

- **Bun 1.3.x unref'd timers never fire on an idle loop** (Windows, observed):
  approval auto-deny, heartbeat, schedule tick, SSE keepalive all used unref →
  removed (server-lifetime timers; correctness over process-hold).
- **Fresh-install crash**: SqliteEventStore.open / SqliteMemoryStore now mkdir
  the dataDir (SQLITE_CANTOPEN on first run).
- **Settings round-trip wiped the stored apiKey** (client PUT the redacted
  object back) — per-field provider merge, regression-tested.
- **New sessions never saw settings changes** — stale closure in main.ts
  sessionConfig; now fresh per create.
- **1970/1/1 session timestamps** — registry folded event.seq as updatedAt;
  StoredEvent gained optional `ts` (from the new created_at column), fold uses
  real write time, UI guards legacy epoch rows.
- **Bun flushes SSE headers only on the first body byte** + 10s default
  idleTimeout killed quiet turns → immediate `: open` flush + 15s keepalive +
  idleTimeout configurable (120s).
- **S6 optional-protocol failure crashed the whole smoke run** — try/catch,
  FAIL not crash.
- **vec0 gotchas** (documented in code): bound params must go through `.all()`;
  default metric is L2 (cosine must be named); canary self-heals dims+metric.

## Verification state

- Full monorepo: **348 tests, 0 fail**; 7 packages typecheck clean.
- Browser end-to-end (real UI, stub provider): settings → model pull → new
  session → streaming → live tool chip (运行中 spinner) → interrupt → history
  render → continue-after-restart → settings dialog → mobile 390px. All pass.
- Real-API smoke: 11/11 PASS zero SKIP (S1-S7 anthropic main link, S6
  openai-compatible swap, S8/S8b real embo-01 semantic rank + restart rebuild).
- Cross-process smoke: 8/8. Subagent adversarial review: PASS (round 2).
- UI critique round: subagent 锐评 vs emotion-ball / codex / deepseek
  screenshots — top findings all implemented (see Critique round above).

## Honest boundaries (do not call these bugs)

- Cross-process spawn-drive deferred (children are registered → any sibling can
  observe/steer/interrupt; only DRIVING is process-local).
- UI second batch (designed, not built): Git/工件 side panel from tool events,
  Ctrl+K command palette, memory Context Cards in transcript, code line
  numbers + diff coloring in Markdown, reasoning trace expansion UI.
- openai-responses protocol still mock-level (no real provider verified).
- Registry titles can be raw assistant text (title = first USER message ≤24
  chars is a TODO in the core registry fold).
- AGENTS.md content size is unbounded (host-owned; capping would hide content).
- Mobile = browser over LAN (no store packaging); TUI intentionally none.

## Commands

```bash
cd packages/<p> && bun test          # tests run per package, never from root
cd packages/<p> && bun run typecheck
bun scripts/sync-agent-runtime.ts [--check]   # engine mirror (8 packages + smoke + docs)
bun run packages/server/src/main.ts  # standalone server (NEWHORSE_UI_DIR to serve UI)
cd apps/web && npm run build         # web dist
cd apps/desktop && npm run build:sidecar && npx tauri build   # NSIS installer
ANTHROPIC_API_KEY=... bun run scripts/smoke/real-api.ts --baseUrl https://api.minimaxi.com/anthropic --model MiniMax-M2
bun run scripts/smoke/cross-process.ts   # no key needed
docs/product-voice.md                        # 定位/命名/配色决策（改 UI 前先读）
bun run scripts/smoke/client-surfaces.ts # no key needed — images/$ARGUMENTS/presets/policy/fork over the transport
```

## Where things live

- `packages/{schema,core,llm,plugin,memory,runtime,server,sdk}` — engine (synced)
- `apps/web` — client SPA (host shell, NOT synced); `src/components/`:
  EmotionBall (v4 engine), Session (transcript+composer), Home (hero),
  Sidebar, ModelPill, SettingsDialog, Pages (Usage/Schedules/Memory), icons
- `apps/desktop` — Tauri shell (host shell, NOT synced); sidecar under
  `src-tauri/binaries/` (gitignored), UI resource `src-tauri/web-dist/`
- `scripts/smoke/{real-api,cross-process}.ts`
- `docs/core-technology-notes.md` §25 (vector index) §26 (cross-process)
  §27 (compaction); `docs/architecture-map.md` (drift sentinel — keep current)

## Suggested next steps (in order)

1. User acceptance of the v4 UI in a real desktop build (visual-polish list
   from the critique: hover glide, pixel loader, reasoning expansion).
2. UI second batch: Git/工件 side panel (data already in tool events), Ctrl+K
   palette, memory Context Cards, code line numbers + diff coloring.
3. Registry title = first user message ≤24 chars (core fold, small + test).
4. openai-responses real-provider verification (needs a key with access).
5. When multi-node deployment becomes real: cross-process spawn-drive.

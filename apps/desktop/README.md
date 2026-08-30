# newhorse 桌面端（Tauri Shell）

桌面端是一个**薄壳**：它只负责把编译好的 runtime server（Bun 单文件可执行）作为 sidecar 拉起，并用 WebView 打开 server 托管的 Web UI（与 API 同源）。所有业务逻辑都在引擎里；壳只管理进程与窗口。

## 三端一体的形态

| 端 | 形态 | 来源 |
|---|---|---|
| 桌面端 | Tauri 2 壳 + `newhorse-server.exe` sidecar + 打包的 Web UI | 本目录 `tauri build` 产物 |
| Web 端（可单独启动） | `NEWHORSE_UI_DIR=<dist> bun packages/server/src/main.ts` | 同一个 dist |
| 手机端 | 桌面端开启局域网访问后，手机浏览器直接访问（PWA 体验） | 同一个 origin |

## 局域网访问开关（手机端）

1. 桌面端「设置 → 局域网访问」：绑定地址改 `0.0.0.0`，设置访问令牌（写入引擎 `~/.newhorse/config.json`，令牌同步存入本机浏览器 localStorage）。
2. 点设置页的「重启服务」（桌面壳的 `restart_server` 命令）：壳读取 config.json 重新以新 host/token 拉起 sidecar。
3. 手机浏览器打开 `http://<电脑局域网IP>:3927`，输入令牌即可（同源 API + UI，无需 CORS）。

## 构建

```bash
# 0) 依赖：Rust (tauri 2)、Bun、Node 18+
# 1) 构建 Web UI
cd apps/web && npm install && npm run build
# 2) 编译 server sidecar（单文件，约 98MB，内含 Bun 运行时）
cd apps/desktop && npm run build:sidecar
# 3) 同步 UI 到壳资源
npm run sync:ui
# 4) 打包（NSIS 安装包 + 可执行文件）
npx tauri build
# 产物：src-tauri/target/release/bundle/nsis/*.exe
```

## 生命周期

- 启动：读 `~/.newhorse/config.json`（host/port/token，UI 设置页写入）→ spawn sidecar（env 传入）→ TCP 轮询等待监听 → 打开窗口。
- 重启：`restart_server` 命令 kill 旧进程 → 重新 spawn → 窗口跳转新地址。
- 退出：`RunEvent::Exit` 时 kill sidecar，不留孤儿进程。

## 已知边界

- 端口固定读取 config.json（默认 3927）；UI 端口变更需重启壳。
- 手机端为浏览器访问（PWA 清单在 web dist 中），非应用商店安装包。
- `NEWHORSE_SHELL_DEBUG=1` 启动壳可看到 sidecar 控制台输出（排障用）。

<p align="center"><strong>newhorse</strong></p>
<p align="center">面向软件项目、个人事务与长期关系连续性的本地优先可编程 AI 工作空间。</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## 概览

Newhorse 是 [OpenCode](https://github.com/anomalyco/opencode) 的独立 fork，将编码智能体 Runtime 扩展为统一的工作与生活 AI 环境。同一套客户端/服务端 Runtime 驱动 Desktop、Web App、TUI、SDK、自动化、模型、Tool、MCP、Session 和 Workspace。

两个产品 Profile 共用这套 Runtime：

- **Assistant** 面向项目执行：代码、文件、终端、研究、计划、任务与 Workspace。
- **Companion** 面向个人连续性：关系感知对话、经确认的 Memory、Reminder、Follow-up 与主动计划。

Profile 不是存储边界。持久内容按 Scope 与 Policy 隔离：项目内容留在项目/Workspace 上下文，个人与关系内容留在 Personal 个人域。Profile 身份本身永远不授予跨域移动内容的权限。

## 核心能力

### 完整的智能体工作空间

- Desktop、浏览器与终端界面
- Project Session、Git Worktree、Personal Workspace、Tab、Terminal、文件 Review、LSP 与 Command
- 多个前台/后台 Agent 及 Tool 委托
- MCP Server、Skill、Plugin、自定义 Command 与权限控制
- 服务端动态模型目录，按 Provider 连接状态与可用性过滤
- 多 Provider 认证与模型偏好，不依赖前端硬编码模型常量

### Assistant 与 Companion

- Session 对 Workspace 与 Profile 的不可变绑定
- 每个 Server 复用唯一固定 Companion Session，跨项目时不会为每个目录新建对话
- 可配置 Companion Persona、Quiet Hours、主动频率与安全上下文
- 结构化 Memory proposal，具备 accept/reject/forget 生命周期
- 持久 Reminder，支持创建、暂停、恢复、取消、lease 与幂等投递
- Follow-up 调度与 Companion Plan，统一管理 proposed Memory、Reminder 和 Continuity Grant
- 自动接受权限支持 Session、Lineage、Directory 优先级，并通过权限所属目录的 Client 响应

### 内容隔离与信任

- 基于 SQLite 的结构化 Memory，包含 Scope、Provenance、Status、Expiration 及 Profile/Workspace 绑定
- Project 内容不会流入 Personal 或 Relationship Memory
- Relationship Memory 不会流入 Project 上下文
- 只有 Policy 允许的 Global Preference 才可投影到工作域
- Personal Workspace 保留完整编程工具；风险动作通过明确的 `ask` 与 `deny` Policy 管理，而不是删减能力
- Personal 上下文中的外部 MCP、Plugin 与 Skill 加载受 opt-in Policy 控制

## 架构

Newhorse 将智能体产品中经常混在一起的职责拆分为：

| 层 | 职责 |
| --- | --- |
| Runtime | Session、Model、Agent、Tool、MCP、Skill、Memory、Scheduler |
| Orchestration | 前台/后台 Agent 组之间的委托与协同 |
| Workspace | Project、Worktree、Personal 环境及执行位置 |
| Content Scope | 持久信息的归属与存储域 |
| Policy | 权限、扩展加载与跨域信息流 |
| Profile | Assistant/Companion 体验、Persona、Memory 行为与主动性 |

主要 Package：

- `packages/opencode` — CLI、Server、Runtime、Session、Tool、Worktree、Policy、Memory、Reminder 与 HTTP API
- `packages/app` — SolidJS 产品 UI 与 Playwright 测试
- `packages/desktop` — Electron Desktop 宿主与安装包
- `packages/tui` — 终端界面
- `packages/sdk/js` — 自动生成及手写的 JavaScript/TypeScript SDK
- `packages/ui`、`packages/session-ui` — 通用 UI 与 Session 组件
- `packages/web` — 营销/文档站点，不是产品 Web Client

## 当前状态

Newhorse 正在持续开发。当前支持源码构建、本地 Web/Desktop 开发、便携 CLI 导出和未签名 Desktop 安装包构建；尚未发布包管理器版本或已签名的公开安装器。

主要基础能力已经落地：

- Central Trust Policy 与不含内容的 Policy Audit
- Assistant/Companion Profile 与 Personal Workspace
- 结构化 Memory、Reminder、Follow-up、Continuity Grant 与 Companion Plan 管理
- 服务端动态 Model/Provider Catalog
- Legacy 与 v2 两套 Settings 布局
- Linux 与 Windows 便携 CLI 导出
- Windows NSIS 与 Linux Desktop 打包路径

统一 Today/每日入口仍明确处于延期状态。macOS Desktop 运行验证以及生产签名/notarization 仍属于发布门槛。

## 环境要求

- [Bun](https://bun.sh) 1.3.x
- Git
- 目标平台要求的构建工具（Electron Builder 会报告缺失依赖）

## 从源码构建

```bash
git clone https://github.com/Lin-A1/newhorse.git
cd newhorse
bun install

# CLI/Server 开发
bun run --cwd packages/opencode dev

# 产品 Web UI 热更新
bun run dev:web

# Electron Desktop 开发
bun run dev:desktop
```

产品 Web UI 由 Newhorse CLI/Server 提供服务。`packages/web` 是单独的营销与文档站点。

## 统一产品命令

根目录的产品编排器会委托现有 Package Script，并跟踪 Target 就绪状态与产物指纹：

```bash
bun run product targets [--json]
bun run product doctor [--target <id>]
bun run product web [--source]
bun run product dev <cli|web|desktop>
bun run product build [--product cli|desktop|all] [--target <id>]
bun run product export [--product cli|desktop|all] [--target <id>] [--execution local|ci|auto] [--force]
bun run product verify --artifact <path>
```

Target 状态具有严格语义：

- **configured** — 构建配置存在
- **exportable** — 存在本地或 CI 导出路径
- **verified** — 产物确实在目标操作系统运行过
- **signed** — 已完成平台签名/notarization
- **releasable** — 已验证、已签名并获得单独发布授权

本地打包成功不会被自动描述为 signed 或 releasable。

## 测试

仓库会主动阻止从根目录扫描测试。请在测试所属 Package 中执行：

```bash
# Backend/Runtime
bun test --cwd packages/opencode
bun run --cwd packages/opencode typecheck

# App
bun --cwd packages/app test --preload ./happydom.ts
bun run --cwd packages/app typecheck
bun run --cwd packages/app typecheck:e2e

# Playwright
bun --cwd packages/app run test:e2e

# 仓库级 Typecheck/Lint 编排
bun run typecheck
bun run lint
```

部分 App 测试要求 browser condition 或 Package 自带的 Happy DOM preload；优先使用最近的 Package Script。

## 打包

### 便携 CLI

```bash
bun run product export --product cli --target windows-x64 --execution local --force
bun run product export --product cli --target linux-x64 --execution local --force
```

便携产物写入 `packages/opencode/dist/exports/`，包括 ZIP、SHA-256 与 Manifest。导出命令不会发布 Release、创建 Tag 或推送 Container。

### Windows Desktop 安装包

在 Windows 上执行：

```powershell
bun run --cwd packages/desktop build
bun run --cwd packages/desktop package:win
```

Electron Builder 将 NSIS 安装器写入 `packages/desktop/dist/`。除非显式配置可信签名环境，否则本地安装包保持 unsigned。CI Desktop 导出通过手动触发、仅上传 Artifact 的 Workflow 提供。

构建结构与 Manifest 保持确定性，但 Bun/Electron payload 可能包含时间戳和路径，因此不保证跨构建逐位一致。应以每次产物自身的 SHA-256 为准。

## 配置兼容

Newhorse 将配置写入 Project 或用户主目录下的 `.newhorse/`。旧 `.opencode/` 路径仍可读取，以支持迁移兼容。Runtime 环境变量优先采用 `NH_*`，并在需要兼容时继续接受上游 `OPENCODE_*` 别名，例如 `NH_DB` / `OPENCODE_DB`。

## 与 OpenCode 的关系

Newhorse 是 [OpenCode](https://github.com/anomalyco/opencode) 的独立 fork，不由 OpenCode 团队开发、背书或提供支持。请在本仓库报告 Newhorse 问题，不要提交到上游。

原项目与本 fork 均遵循各自适用的许可条款，详见 [LICENSE](./LICENSE)。

## 贡献

提交 Pull Request 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。测试必须按 Package 执行；不得提交凭据或内部交接文档；验证边界必须如实报告。

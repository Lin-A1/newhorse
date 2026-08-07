<p align="center"><strong>newhorse</strong></p>
<p align="center">一个本地优先、可编程的 AI 工作空间，用于项目协作、个人连续性和多端智能体工作流。</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## 概览

Newhorse 是一个独立的 [OpenCode](https://github.com/anomalyco/opencode) 分支，把编码智能体运行时扩展成更完整的工作与生活环境。相同的运行时同时支撑桌面端、Web 端、TUI、SDK、自动化、模型、工具、MCP Server、Session 和 Workspace。

同一套运行时下有两种产品 Profile：

- **Assistant** 面向项目执行：代码、文件、终端、研究、计划、任务和 Workspace。
- **Companion** 面向个人连续性：关系感知对话、已确认的记忆、提醒、跟进与主动关怀计划。

Profile 不是存储边界。持久内容会按作用域和策略隔离：项目内容留在项目/Workspace 域，个人和关系内容留在个人域。

## 核心能力

### 完整的智能体工作空间

- Desktop、浏览器与终端界面
- Project Session、Git Worktree、Personal Workspace、Tab、Terminal、文件 Review、LSP 与 Command
- 多个前台/后台 Agent 及 Tool 委托
- MCP Server、Skill、Plugin、自定义 Command 与权限控制
- 服务端动态模型目录，按 Provider 可用性过滤
- 多 Provider 认证与模型偏好，不依赖前端硬编码列表

### Assistant 与 Companion

- Session 对 Workspace 与 Profile 的不可变绑定
- 每个 Server 复用唯一固定 Companion Session，跨项目不会新建一条对话
- 可配置 Companion Persona、Quiet Hours、主动频率与安全上下文
- 结构化 Memory proposal，具备 accept/reject/forget 生命周期
- 持久 Reminder，支持创建、暂停、恢复、取消、lease 与幂等投递
- Follow-up 调度与 Companion Plan，统一管理 Memory、Reminder 和 Continuity Grant
- 自动接受权限支持 Session、Lineage、Directory 优先级

### 内容隔离与信任

- 基于 SQLite 的结构化 Memory，包含 Scope、Provenance、Status、Expiration 及 Profile/Workspace 绑定
- Project 内容不会流入 Personal 或 Relationship Memory
- Relationship Memory 不会流入 Project 上下文
- 只有 Policy 允许的 Global Preference 才可投影到工作域
- Personal Workspace 保留完整编程工具；风险动作由明确的 Policy 控制，而不是删减能力
- Personal 上下文中的外部 MCP、Plugin 与 Skill 加载采用 opt-in

## 架构

Newhorse 将智能体产品中常被混在一起的职责拆分为：

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

Newhorse 仍在持续开发中。当前支持源码构建、本地 Web/Desktop 开发、便携 CLI 导出和未签名 Desktop 安装包构建；尚未发布包管理器版本或公开签名安装器。

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
- Electron Builder 所需的平台构建工具

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

产品 Web UI 由 Newhorse CLI/Server 提供服务。`packages/web` 是独立的营销与文档站点。

## 产品命令

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

Target 状态的含义如下：

- **configured** — 构建配置存在
- **exportable** — 存在本地或 CI 导出路径
- **verified** — 产物已在目标操作系统成功运行
- **signed** — 平台签名/notarization 已完成
- **releasable** — 产物已验证、已签名，并获得发布授权

本地打包成功不会自动被视为 signed 或 releasable。

## 测试

请在 Package 目录内运行测试，不要从仓库根目录运行。

```bash
bun run --cwd packages/app typecheck
bun run --cwd packages/opencode typecheck
bun run --cwd packages/opencode test
bun run --cwd packages/opencode test:httpapi
```

## 贡献

中文版本见 `README.zh.md`。提交代码时尽量保持改动聚焦，优先使用小而清晰的补丁。
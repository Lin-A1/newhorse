<p align="center"><strong>newhorse</strong></p>
<p align="center">面向工作与生活的统一可编程智能体，按内容域隔离持久化数据。</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## Newhorse 是什么

Newhorse 是一个统一的可编程 AI 智能体，把 Assistant 与 Companion 能力融合在同一使用体验中。它可以处理代码、文件、命令、研究、个人事务、生活复盘和提醒，不要求用户在两个割裂的产品之间来回切换。

Assistant 与 Companion 是可以兼容并存的体验 Profile，而不是相互隔离的应用。它们共用一套 Runtime，也可以在同一体验中配合使用。真正的硬边界是内容域：

- **工作内容**归属于具体 Project、Workspace 或任务/事务上下文。
- **个人与关系内容**归属于 Personal 个人域。
- **全局偏好**可在策略允许时流入工作上下文；项目内容不会流入个人或关系记忆，关系记忆也不会向外流动。

Profile 决定体验、Persona、记忆策略和主动能力侧重，但不能单独决定内容存到哪里。

## 产品模型

Newhorse 将六类职责分开：

- **Runtime** 提供 Session、模型、Agent、Tool、MCP、Skill、Memory 和 Scheduler。
- **Orchestration** 让同一个入口把 Coding、Assistant 与 Companion 工作委托给多个前台或后台 Agent 组并行处理。
- **Workspace** 标识当前项目或个人环境。
- **Content Scope** 决定持久化信息属于哪个内容域。
- **Policy** 控制权限、扩展加载和跨域信息流。
- **Profile** 调整 Assistant/Companion 体验，不创建另一套 Runtime。

所有 Workspace 都保留完整编程工具。Personal Workspace 不是能力受限的笔记模式；风险动作由明确的 `ask` 和 `deny` 策略管理。

## 与 OpenCode 的差异

Newhorse 建立在 [OpenCode](https://github.com/anomalyco/opencode) 的工程底座上，但产品方向更广。

### 从 OpenCode 保留

- 终端与 TUI 工作流
- 多模型供应商支持
- 编码工具、Agent、LSP、MCP、Skill、Session、Project 和 Worktree
- 可扩展的客户端/服务端架构

### Newhorse 已实现

- Session 对 Workspace 与体验 Profile 的不可变绑定
- Personal Workspace，并保留与项目 Workspace 相同的核心代码和文件能力
- 外部 MCP、Plugin 和 Skill 在 Personal Workspace 中连接或加载前执行显式 opt-in 控制
- 基于 SQLite 的结构化记忆，具备 Workspace/Profile scope、生命周期状态、过期机制，以及需要确认的模型推断 proposal
- 同一 Runtime 内的 Assistant 与 Companion Profile，包括 Persona 配置和受保护的 Companion 安全上下文
- 持久提醒和显式订阅的主动消息基础，支持暂停、静默时段、频率、lease、幂等和审计，并已在 App 设置（legacy/v2 两种布局）与 TUI 中提供 Reminder 管理界面
- 一个 Companion 计划审查界面，在一个页面聚合 proposed Memory、周期 Reminder 和最小化 Continuity Grant，且不读取原始 Session 历史
- Setup 命令、强类型 Skill 参数、App/TUI 接入，以及 Linux/Windows 本地便携 CLI 导出
- 适配 fork 的 GitHub Actions，避免在本仓库执行仅属于上游的自动化

### 仍在闭环

- Project/Task 与 Personal/Relationship 存储之间统一、显式的 Content Scope Policy，以及统一 Trust Policy 的 enforcement 调用点迁移
- 脱敏 Capability 状态诊断与完整 Workspace Policy 矩阵
- 完整 Companion 安全评测矩阵与关系记忆重置流程
- 跨 OS 便携运行验证（Linux 运行时 smoke）与目标 runner 上的 Desktop 安装包 smoke
- 剩余 V2 adapters、迁移覆盖与发布成熟度

仓库不会把这些进行中的工作描述为已完成功能。

## 当前状态

Newhorse 正在持续开发。当前支持源码构建和便携 CLI 产物，但尚未发布包管理器版本或签名安装器。

项目正在按 Phase 逐项闭环：保留并测试已有基础，同时将安全、内容隔离、Memory 管理、主动投递和跨平台交付补齐到完整验收标准。

## 从源码构建

需要 [Bun](https://bun.sh)。

```bash
git clone https://github.com/Lin-A1/newhorse.git
cd newhorse
bun install
bun run --cwd packages/opencode dev
```

仓库会主动阻止在根目录运行全套测试，请执行 package-local 检查：

```bash
bun test --cwd packages/opencode
bun run --cwd packages/opencode typecheck
bun run --cwd packages/app typecheck
bun run typecheck
```

部分前端测试需要浏览器条件：

```bash
bun test --conditions=browser --cwd packages/app
```

## 统一产品命令

一个统一编排器负责查看 target、检查环境、启动 Web 入口、运行开发宿主，以及驱动构建、导出和产物校验。它只委托给现有 package 脚本，绝不重新实现打包或构建逻辑。

```bash
bun run product targets [--json]        # 所有 target 及 configured/exportable/verified/signed/releasable 状态
bun run product doctor [--target <id>]   # 主机与 target 就绪检查，包括仍缺失的 runner
bun run product web [--source]           # 启动产品 Web 入口（nh web）
bun run product dev <cli|web|desktop>    # 运行开发宿主
bun run product build [--product cli|desktop|all] [--target <id>]
bun run product export [--product cli|desktop|all] [--target <id>] [--execution local|ci|auto] [--force]
bun run product verify --artifact <path> # 静态校验：存在性、大小、sha256
```

导出是增量的。编排器会为每个 target 记录输入指纹（相关源码、lockfile、配置、Bun 版本、target、version），当输入与上一次产物均未变化时跳过构建。需要强制重建时加 `--force`；修改任一指纹输入（源码改动、`bun install`、版本号变更）都会使缓存失效。

状态语义刻意保持严格：

- **configured** — 代码与配置存在。
- **exportable** — 存在本地或 CI 导出路径。
- **verified** — 产物确实在目标 OS runner 上运行过。
- **signed** — 已完成代码签名和/或 notarization。
- **releasable** — verified、signed 且经单独授权。

无法在当前主机诚实验证的 target 会如实报告（`doctor` 会打印缺失的 runner），而不是被静默当作就绪。

## 启动 Web 入口

产品 Web 界面通过 CLI 启动，CLI 同时运行本地服务端：

```bash
bun run product web
# 或从源码：
bun run --cwd packages/opencode dev web
```

如需带热更新的 UI 开发，可运行 Vite 开发服务器（此时需要单独的服务端）：

```bash
bun run product dev web
```

`packages/web` 是营销/文档站点，不是产品 Web 界面。

## 便携 CLI 导出

本地生成便携包，并且不发布 Release：

```bash
# 统一入口
bun run product export --product cli --target linux-x64 --execution local

# 直接调用 package 脚本（产物契约相同）
bun run --cwd packages/opencode export:local --target windows-x64
```

正式可导出的 CLI target 为 `linux-x64`、`windows-x64` 和 `windows-x64-baseline`。`linux-x64` 已在 Linux 主机上完成产物运行时验证（`nh --version` 返回包版本、`nh setup profile --help` 可运行）；`windows-x64` 与 `windows-x64-baseline` 已完成本地交叉编译与结构验证，运行时验证需在 Windows runner 上通过 `export-cli` 工作流的 `validate-windows` job 完成。产物写入 `packages/opencode/dist/exports/`，包括 ZIP、SHA-256 校验文件和 manifest。该导出流程不会发布 npm 包、创建 GitHub Release、推送容器或创建 Git tag。

这是便携 CLI 归档，不是已签名的 Windows 安装器。Desktop 安装包（Windows NSIS、macOS DMG/ZIP、Linux AppImage/DEB/RPM）需要在各自操作系统上构建和验证；目前尚不存在已签名或已发布的正式版本。

对于本机缺少工具的 Desktop 安装包，可运行 `export-desktop` GitHub Actions 工作流（手动 `workflow_dispatch`、仅产物）：Linux job 会在 runner 上安装 `rpm` 并产出 AppImage/DEB/RPM，Windows job 产出 NSIS 安装器，macOS job 产出 DMG/ZIP（不执行签名和 notarization，需带凭据的 macOS runner）。这是 RPM、Windows 安装器与 macOS 目标的 CI 路径；`bun run product doctor` 会打印本机解除阻塞所需的命令。

## Memory 与内容隔离

Runtime 当前使用 SQLite 存储结构化 Memory。记录包含 scope、Workspace/Profile 绑定、来源、状态和过期元数据。模型推断的记录会进入 `proposed` 状态，而不是自动成为可信事实。

目标存储约束比 Profile 切换更严格：

- 项目和事务内容留在对应工作域。
- 个人、生活和关系内容留在 Personal 个人域。
- 只有策略允许的全局偏好可以跨入工作域。
- 在加密、密钥轮换、备份和删除保证完整落地前，系统继续拒绝保存高敏信息。

剩余的 Domain 强制与管理能力属于当前进行中的开发工作。

## Profile 与 Runtime Agent

Assistant 与 Companion 是同一智能系统中的体验 Profile，可以兼容使用。一个统一入口可以编排多个平行 Agent 组，分别处理 Coding、通用 Assistant 与 Companion 取向的工作。**build**、**plan**、**general** 等 Runtime Agent 属于另一层：它们负责执行与委托分工，不代表产品，也不决定存储域；Agent 身份本身永远不构成跨域移动内容的授权。

## 配置兼容

Newhorse 配置位于项目目录或用户主目录下的 `.newhorse/`，Newhorse 专用环境变量使用 `NH_` 前缀。迁移期间，仍会在需要兼容的路径读取旧 `.opencode/` 目录和 `OPENCODE_` 变量。

## 与 OpenCode 的关系

Newhorse 是 [OpenCode](https://github.com/anomalyco/opencode) 的独立 fork，并非由 OpenCode 团队开发，也未获其背书，与其没有隶属关系。Newhorse 的问题请提交到本仓库，不要提交到上游。

原始工作与本 fork 均遵循各自适用的许可条款，详见 [LICENSE](./LICENSE)。

## 贡献

提交 Pull Request 前请先阅读[贡献指南](./CONTRIBUTING.md)。

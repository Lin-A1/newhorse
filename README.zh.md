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
- 持久提醒和显式订阅的主动消息基础，支持暂停、静默时段、频率、lease、幂等和审计
- Setup 命令、强类型 Skill 参数、App/TUI 接入，以及 Linux/Windows 本地便携 CLI 导出
- 适配 fork 的 GitHub Actions，避免在本仓库执行仅属于上游的自动化

### 仍在闭环

- Project/Task 与 Personal/Relationship 存储之间统一、显式的 Content Scope Policy
- 脱敏 Capability 状态诊断与完整 Workspace Policy 矩阵
- Memory 管理界面、导出、纠正和事务化按域清除
- 完整 Companion 安全评测矩阵与关系记忆重置流程
- 周期提醒、崩溃安全的投递去重与 Reminder 管理界面
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

## 便携 CLI 导出

本地生成 Windows x64 便携包，并且不发布 Release：

```bash
bun run --cwd packages/opencode export:local --target windows-x64
```

其他支持的 target 为 `windows-x64-baseline` 和 `linux-x64`。产物写入 `packages/opencode/dist/exports/`，包括 ZIP、SHA-256 校验文件和 manifest。该导出流程不会发布 npm 包、创建 GitHub Release、推送容器或创建 Git tag。

这是便携 CLI 归档，不是已签名的 Windows 安装器。

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

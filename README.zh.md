<p align="center">newhorse</p>
<p align="center">具备结构化长期记忆的 AI 编码代理。</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

### 这是什么

newhorse 是一个运行在终端里的 AI 编码代理。它可以读写代码、执行命令，并且会把你的偏好、
项目背景和你给过的反馈持续记下来，这样你不必在每个新会话里重复交代同样的事情。

本项目基于 [opencode](https://github.com/anomalyco/opencode) 二次开发，新增了结构化记忆层
和工作区隔离机制。详见[与 opencode 的关系](#与-opencode-的关系)。

### 当前状态

早期开发阶段。目前还没有发布到包管理器，也没有安装脚本，请从源码构建。

### 从源码构建

需要 [Bun](https://bun.sh)。

```bash
git clone https://github.com/Lin-A1/newhorse.git
cd newhorse
bun install
bun run --cwd packages/opencode dev
```

运行测试：

```bash
bun test
```

### 记忆机制

newhorse 会在会话之间维护基于文件的记忆，分为四类记录：

- **user** — 你的角色、目标和工作偏好
- **feedback** — 你给过的指导，包括哪些做法有效、哪些要避免
- **project** — 无法从代码本身推导出的工作背景
- **reference** — 指向外部系统的线索，说明信息存放在哪里

记忆按工作区隔离。全局偏好会单向流入工作区，但工作区内的记录不会外泄。模型自行推断出的
记录只会存为待确认状态，不会被当成既定事实。

### 代理

内置两个代理，用 `Tab` 键切换：

- **build** — 完全权限，用于日常开发
- **plan** — 只读，用于分析和代码探索；默认拒绝文件修改，执行命令前会先征求许可

另有 **general** 子代理处理复杂搜索和多步任务，在消息中用 `@general` 调用。

### 配置

配置位于项目目录或用户主目录下的 `.newhorse/`，环境变量使用 `NH_` 前缀。
旧的 `.opencode/` 目录和 `OPENCODE_` 变量仍会被读取以保持兼容。

### 与 opencode 的关系

newhorse 是 [opencode](https://github.com/anomalyco/opencode) 的独立分支，并非由 opencode
团队开发，也未获其背书，与其没有任何隶属关系。newhorse 的问题请提交到本仓库，不要提到上游。

原始项目的许可条款依然适用，详见 [LICENSE](./LICENSE)。

### 贡献

提交 PR 前请先阅读[贡献指南](./CONTRIBUTING.md)。

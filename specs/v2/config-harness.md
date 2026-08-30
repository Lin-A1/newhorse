# Config harness 设计 Spec

> 状态：**部分实现（2026-08-30）** — `runtime/config.ts` 已落地（ENV 唯一表 + AGENT_RUNTIME_HOME + 分层 merge + 强类型）；server main.ts 已消费；CLI 收敛与 L2 文件层见下。

---

## 0. 定位与归属（核心决策）

| 归属 | 配置内容 | 目录 |
|---|---|---|
| **agent-runtime（引擎 harness）** | provider/model、memory 开关、bash/plugin trust、server port/token | `AGENT_RUNTIME_HOME`（默认 `~/.newhorse`，宿主可重定向） |
| **newhorse（IDE 宿主 harness）** | 工作区列表、UI、宿主插件目录 | `~/.newhorse/ide.json`（IDE 阶段做） |
| **工作区覆盖** | 项目专属 runtime 覆盖 | `<workspace>/.newhorse/config.json`——**宿主读取，runtime 段经 sessionConfig 显式传引擎** |

**两条边界铁律**：
1. 引擎不知道 `.newhorse/` 是什么——宿主决定传什么（配置版 "transport 零领域逻辑"）。
2. **工作区文件是模型可写的，因此永远不能升级 execpolicy/provider**——工作区层只能降级。这是工作区层延后到 IDE 阶段的安全原因（需要"可覆盖键白名单"的设计深度）。

## 1. 分层（高胜低）

```
L1 引擎默认（config.ts） < L2 家目录文件（~/.newhorse/config.json，待做） < L3 工作区（宿主职责，不做于引擎） < L4 运行时调用（sessionConfig，已有） < L5 env（最高）
```

## 2. 已实现

- `ENV` 表（唯一权威——CLI/server 不再各写一份 env 读取）。
- `AGENT_RUNTIME_HOME`（默认 `~/.newhorse`）——dataDir/memory.db/rules 全归它；宿主重定向 = 配置版 "home 搬迁"。
- `loadRuntimeSettings({env, cli, agentHome})` → 强类型 `RuntimeSettings`（分层 merge：defaults < cli < env）。
- server main.ts 消费（**per-session provider override 修复**——原 main.ts 忽略 create.provider）。
- 测试：defaults/env 重定向/cli 优先/kind-specific key 回退。

## 3. 待做

- **L2 家目录文件**（`~/.newhorse/config.json`）：读 + merge + 校验（schema 校验 + 未知键告警）。
- **CLI 收敛**：`resolveProvider`/`runDagCli` 的 env 读取改消费 config 模块。
- **IDE harness**（newhorse 阶段）：`IdeSettings` 形状 + 工作区覆盖白名单设计。

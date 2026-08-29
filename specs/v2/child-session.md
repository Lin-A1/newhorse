# Child Session Base (Phase 2) 设计 Spec

> 状态：**已实现（2026-08-29）** — `packages/runtime/src/context.ts`（可插拔 provider）+ `dag-runner.ts`（location 继承 + 首轮 system 注入）+ `hub.ts`（spawn location）。测试 2 个（location + system、可插拔 provider）。实现记录见 `docs/core-technology-notes.md` §19。
> 目标：spawn 出的子会话是**活的、被驱动的**、**继承工作区上下文**、**结果回填父会话**。这是模型编排（spawn_agent/followup）与 DAG 的**共同地基**。
> 可插拔性（AGENTS.md）：workspace context 组装是 **provider seam**——默认实现 = AGENTS.md 目录发现；调用方可替换（如给子节点注入不同/更窄上下文）。不做硬编码分支。

---

## 0. 当前缺口（代码事实）

- `dag-runner.ts:188` 写 `Session.Created { location: "" }` → 子节点**没有 AGENTS.md、没有 Workdir**。
- `hub.spawn`（butler spawn_agent 用）同样写 `location: ""`，且**没有任何代码驱动子会话**（死行）。
- `app.ts:220-234` 的 system-context 注入是**主 prompt 内联**，不供子会话复用。

---

## 1. 设计

### 1.1 Context provider seam（可插拔）

```ts
// packages/runtime/src/context.ts (new)
export type SessionContextProvider = (workspace: string) => Promise<string>

/** Default: AGENTS.md discovery + compose. Same as the current app.ts logic. */
export const defaultContextProvider: SessionContextProvider = async (workspace) => {
  const docs = await discoverWorkspaceContext(workspace)
  const docsCtx = composeSystemContext(docs)
  const rootLine = `Workdir: ${workspace}` + (docsCtx ? "\n\n" : "")
  return docsCtx ? rootLine + docsCtx : rootLine
}
```

- `defaultContextProvider` 是内置默认；`createApp` / `runDag` 都接受 `contextProvider?`（缺省用默认）。`hub.spawn` 目前只接受 `workspace`（Phase 2 只做 location 继承；spawn 的子会话尚未注入 system context——见 §1.4 边界）。
- **替换点**：调用方传自定义 `contextProvider` 即覆盖（如给子节点注入任务说明而非文件夹 AGENTS.md）。无 `if/switch` 分支。

### 1.2 子会话系统上下文注入（DAG 路径）

`runNode` 在 `Session.Created` 后、`inbox.admit` 前，把 system message 追加到子会话日志——**与主会话相同的"先入 log 再可见"规则**：

```ts
// 在 runNode 中，childSessionId 创建后：
const sysText = await ctxProvider(workspace)
if (sysText) append system message to childSessionId log (if none exists)
```

- 用于 `Session.Created` 后第一轮；复用检查（已有 system 消息则不重复）与主会话一致。

### 1.3 子会话 location 继承

- `dag-runner.ts:188`：`location: deps.workspace ?? process.cwd()`（不再 `""`）。
- `hub.spawn`：`location: parentWorkspace`（`spawn_agent` 工具需要带 workspace 参数的 hub）。

### 1.4 驱动子会话 + 结果回填（模型编排基座）

- **drive**：`spawn_agent` 工具调用后，runtime 应真正 `runSession` 子会话（后台），而不仅是写 `Session.Created`。
- **回填**：子会话完成后，把结果投递到父会话 inbox（`Prompted` 事件 `principal:"parent"`），父会话被唤醒。
- **task_id**：子会话聚合 id 即 task_id；`followup_task` 用它续跑/查询。

**Phase 2 范围**：先做 workspace 继承 + system context 注入（DAG 路径，这是最小可验证增量）；**驱动 + 回填**在同一阶段的后半（模型编排工具依赖它）。本 spec 先定 context seam + DAG 子会话继承；驱动/回填接口单独定。

---

## 2. 接口变化

| 文件 | 变化 |
|---|---|
| `packages/runtime/src/context.ts` (新) | `SessionContextProvider` 类型 + `defaultContextProvider` |
| `packages/runtime/src/app.ts` | `AppConfig.contextProvider?`；`prompt` 用它替代内联 |
| `packages/runtime/src/dag-runner.ts` | `DagDeps.contextProvider?`；`runNode` 写 location + 注入 system |
| `packages/runtime/src/hub.ts` | `Session.Created.location` = parentWorkspace（需要把 workspace 传进 spawn） |
| `packages/runtime/src/index.ts` | 导出 context providers |

---

## 3. 验收

- [x] `dag-runner.test.ts`：DAG 子会话的 `Session.Created.location` 是 workspace（非 `""`）
- [x] `dag-runner.test.ts`：首轮 turn 前 system context（含 Workdir + AGENTS.md）已入子会话日志
- [x] 主会话行为不变（`app.ts` 的 prompt 仍注入 system）
- [x] 可插拔：传自定义 `contextProvider` 产生不同 system 文本（测试）
- [x] `bunx tsc --noEmit` 干净 + 全测试通过
- [ ] 独立 subagent 复审（MUST-FIX 关闭）

---

## 4. 边界

- **不**在本阶段实现：模型编排工具（spawn_agent/followup 真驱动）、DAG 持久化 slot/resume（Phase 3）。
- **可插拔性强调**：context provider 是 seam，不是"if workspace 包含 AGENTS.md 就注入"的硬编码；注入逻辑复用同一函数，杜绝散落分支。

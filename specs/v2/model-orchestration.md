# Model Orchestration + DAG Resume (Phase 3) 设计 Spec

> 状态：**部分实现（2026-08-30）** — `specs/v2/plan.md` Phase 3。已完成：`driveChildSession`（共享子会话驱动）、DAG 持久化 slot（NodeResolved.output）、`resumeDag`（崩溃后复活）、hub 可插拔 ChildDriver seam。**未完成**：spawn_agent 工具携带 prompt 的全链路驱动（app.ts 尚未接线 driver）、结果回填（Session.Settled 已定义但驱动路径未 emit）、followup_task/wait、send_message 真投递。实现记录见 `docs/core-technology-notes.md` §20。
> 建立在 Phase 2 基座上：子会话已有 workspace 继承 + context seam。本阶段喂给它"真实驱动的生命"。

---

## 0. 现状缺口（代码事实）

- `hub.spawn` 写 `Session.Created + Session.Spawned` 后**无任何驱动**——死会话。
- `spawn_agent`（butler.ts）调用 `spawnFrom` 拿 child id 即返回；child 不会跑。
- DAG `NodeResolved` 只持久化 `outputRef: session:<id>`；`output`（真实文本）只在内存 `slotStore`。
- `replayDag` 折叠状态但**不能续跑**（pending 节点不会重泵）。

---

## 1. 设计

### 1.1 进程内 SessionManager（可插拔）

```ts
// packages/runtime/src/session-manager.ts (new)
export interface ManagedSession {
  readonly sessionId: string
  readonly aborted: boolean
  readonly settled: boolean
  run(opts: { text: string; agent: Agent }): Promise<void>  // 启动/续跑
  interrupt(): void
}
```

- 一个进程级 `Map<sessionId, ManagedSession>`——**单一写者**（一个 session 同一时刻只一个 run），wake-coalescing（opencode `SessionRunCoordinator` 模式：run 进行中来的新输入只标记 pendingWake，当前 run 完再 re-drain）。
- `app.prompt` 注册/注销其 controller；`hub.send` / `spawn` 经 manager 驱动 target。
- **可插拔**：manager 本身是 runtime 内部实现；对外仍是 `hub.spawn/send/interrupt` 接口（不变），只是内部从 stub 变真。

### 1.2 驱动 + 回填语义（模型编排）

- **spawn**（`spawn_agent`）：创建 child session → 立即用 manager 驱动（后台）→ 返回 `childSessionId`（= task_id）。
- **回填**：child 的 runSession 结束（settle）后，`reportFrom(child, parentId)` 把 child 的 assistant 文本经**父 inbox** 以 `Prompted` 事件（`principal: "parent"`）投递 → 父被唤醒（下一轮看到）。
- **followup_task**：按 task_id 查 child 状态（`ended`? `succeeded`?）或续跑（若 child 未 settle，再驱动一次）。
- **wait**：等待 child settle（带 clamp timeout）。
- **send_message**：向 running 的 child 投递 steer（inbox），可触发其下一轮。
- 每次回填都是**持久事件**（child 的 `Session.Settled` + 父的 `Prompted`），所以跨进程仍可重放——不是内存-only。

### 1.3 DAG 持久化 slot + resumeDag

- `DAG.NodeResolved.data` 增加 `output`（child 的真实 assistant 文本，节选）——持久化，不依赖内存。
- `replayDag` → **新增 `resumeDag(events, dagId, deps)`**：
  1. 折叠 + 从 `NodeResolved` 重建 slotStore；
  2. 重泵非 terminal 的 active pending 节点（复用现有 pump，跳过已 settled）。
- 这修复"重启后只能看尸体"——`resumeDag` 能续跑崩溃前的 DAG。

### 1.4 数据契约

- `Session.Settled`（新事件，`aggregate:"session"`）：child 完成时写入（`{ sessionId, finish }`）——`followup_task`/`wait` 读它判状态，不依赖进程内存。
- `Prompted` 的 `principal:"parent"` 已存在（schema/event.ts），回填复用。

---

## 2. 接口变化

| 文件 | 变化 |
|---|---|
| `packages/schema/src/event.ts` | 加 `Session.Settled` |
| `packages/runtime/src/session-manager.ts` (新) | `ManagedSession` + 进程 map + wake-coalescing |
| `packages/runtime/src/hub.ts` | `spawn`/`send`/`interrupt` 接 manager（从 stub 变真） |
| `packages/runtime/src/dag-runner.ts` | NodeResolved 带 output；`resumeDag` |
| `packages/runtime/src/app.ts` | `app.prompt` 与 manager 协调（注册 controller） |

---

## 3. 验收

- [ ] `spawn_agent` 工具调用后 child 真被驱动（mock llm 断言 child 收到并产生输出）
- [ ] child settle 后父 inbox 收到回填（`Prompted` principal:"parent"）
- [ ] `followup_task` 能查 child 状态（用 `Session.Settled`）
- [ ] `resumeDag`：崩溃后（NodeStarted 留下 running）续跑而非看尸体
- [ ] `bunx tsc --noEmit` 干净 + 全测试通过
- [ ] 独立 subagent 复审（MUST-FIX 关闭）

---

## 4. 边界

- **不**做跨进程 manager（M4 SessionManager）；本阶段 manager 是进程内。
- **不**做 compaction / 成本可见（Phase 4）。
- 可插拔性：对外接口（hub）不变，manager 是内部实现；未来跨进程时替换 manager 实现即可。

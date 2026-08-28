# M2 规划：Global Session Registry + 管家

日期：2026-08-28
状态：设计规划（未实现）—— 先对齐范围，MR 后再落 docs/ 与代码。

---

## 0. 结论先行（可执行，不含糊）

M2 **拆两段**，优先级从"便宜零风险"到"差异化深水区"递进：

- **M2a（本轮做）**：Global Session Registry（会话索引）+ 观察性控制面（list / 只读投影 / interrupt）。
- **M2b（下一轮，需先定权威模型）**：管家特权 LLM 会话 + send_to_session / spawn_agent + 感知反向通道。

**为什么拆两段**：管家"自动能动性"（send/spawn）是 DSH 明示回避的深水区（权威模型未定义前，给 LLM 盲目的能动性最危险）。**M2 的差异化头牌是管家（M2b）；M2a 是管家的依赖 seam，不是独立卖点**——管家要 `list`、要定位 session、要可审计 send/spawn 的 parent 链，这些都由 M2a 提供。先让管家"看得见"，再让它"动得了"。

**关于"对齐 cc-switch"**：cc-switch 已把"会话索引 + resume"形态商品化。M2a 的价值**不是**复刻 cc-switch（那是基建），而是它超出 cc-switch 的部分：可编程查询面、事件驱动投影、以及与管家 parent 链的挂钩。文档明确：M2a 是基建，差异化在 M2b 管家。

---

## 1. M2a：Global Session Registry

### 1.1 它是什么

一个会话索引，作为**派生读模型**（single-writer + materialized read model，即 CQRS 读端）。它记录**关于会话的元数据**，不是会话内容。每个工作区下跑了哪些 session、各自什么状态、归属哪个项目——这一查索引就能回答。

事件日志是**单一写者**（唯一权威事实源）；registry 表是**只由事件驱动重建**的读端投影，**绝不作为权威事实源被独立写**。若 registry 丢，重放事件即可重建。registry 写自己的表，这是"派生写而非权威写"——不是"不双写"（它是派生物化读模型）。

参照 cc-switch session-manager（`sessionId / projectDir / summary` + resume 钩子），扩展到多 runtime：

```
registry_row (aggregate_key = sessionId)
  session_id   text  primaryKey
  workspace    text
  project_id   text      -- 从 session.location 归一化
  title        text      -- 会话可读标题，可空
  status       text      -- "idle" | "active" | "running" | "settled" | "interrupted"
  model        text      -- 当前模型
  parent_id    text      -- 父会话（subagent 归属），可空
  runtime      text      -- 产生它的 runtime（单进程 = "local"）
  created_at   integer
  updated_at   integer
```

### 1.2 数据从哪来：惰性查询（不做 append 广播）

**关键决定（锐评裁定）：M2a 选"方案 B：惰性查询 EventStore"，不选"方案 A：append 广播"。**

理由：
- M2a 的控制面全是 **pull**（list/get/interrupt），没有真正的 push 消费者，方案 A 买来的"实时"是零收益。
- 方案 A 要求"每次 append 都过 bus",但 M1 的 `EventStore.append` 调用点散落 8 处（app.ts/input.ts/loop.ts），且 store 是**冻结契约**（docs §3）——挂 hook 会侵入被冻结的存储层，且让 store 被迫感知"有人监听"。
- M1 有两套事件词汇：`SessionEvent`（durable）和 `LoopEvent`/`AppEvent`（live-only）。M1 现有的 `app.onEvent` 送的是 **LoopEvent**,不是 durable 的 SessionEvent。若要方案 A，得凭空造一条 durable SessionEvent 总线，无消费者、负收益。

**因此 M2a 不做持久化物化表**（单进程小规模下过度）。registry 对 EventStore 做懒查询：`aggregateIds()` + 逐 aggregate `read()` + fold（复用 Session.replay 的 fold 逻辑），首查时物化到内存索引。

```text
list(query) -> 懒查询 aggregateIds() + read() + fold
               物化/增量进内存索引
created_at   <- Session.Created
status       <- Session.StepEnded("settled") / Session.Interrupted("interrupted")
updated_at   <- Session.StepEnded 或任何 append（粗触，不猜"一轮结束"）
```

**注意**：`Session.StepEnded` 是 turn 边界（loop.ts 直接 append）；`MessageAppended` 不带 turn 边界标记，**不要**用它判"一轮结束"来更新时间戳。

### 1.3 接口（注册表 seam）

一个 `SessionRegistry` 服务，作为 registry seam 的 Consumer 侧：

```ts
list(query?: { workspace?: string; status?: string; projectId?: string }): Promise<SessionRow[]>
get(sessionId): Promise<SessionRow | undefined>
// 支持增量：refresh() 重新查询有变化的 aggregate
```

- 内部把 session 事件 fold 成内存索引（惰性：查询时才对 EventStore 做 aggregateIds()+read()）。
- `list` 是**观察性**查询：返回投影，不做任何干预。
- 无 `onEvent` 回调（方案 A 才有）——因此天然规避 "no scattered type branches"。

### 1.4 与调用方的关系

registry 是纯读端，不反向依赖管家。

- `list_sessions` 工具：M2b 管家 LLM 会话通过它查询。
- M2a 不实现管家，只实现 registry + 可测的 `list`/`interrupt` 入口。

### 1.5 与 "no reverse dependency" 红线

registry 只依赖 `schema`（SessionEvent）与 `EventStore`（均位于 core 或 core-read），向下依赖，符合红线。**选 B（懒查询）后，core 的 store/loop/session 零改动**——不需要在 EventStore 挂 hook，也不需要新建 durable 事件总线。

若将来（M2b 管家 / TUI）真要实时 push：**不在 EventStore 层挂 hook，也不在 Session aggregate 层碰**——放在 runtime 装配层（app.ts）用一个"发布式 EventStore 装饰器"包裹传给 runSession 的事件流，append 成功后顺带 emit durable 事件。这是未来增量的正确形态，不是现在的 M2a。

> 注意：这是一个"进程内总线"，不是持久机制。跨进程（M4）才需要 durable mailbox。M2a 明确单进程，符合 M1 边界。

---

## 2. M2a：观察性控制面（list / interrupt）

这是 M2a 的"能动性"上限——**观察 + 叫停**，不做"主动改动别人状态"。

- `list`：查询会话投影（喂给未来的管家 LLM / 喂给 TUI）。按 workspace/status/projectId 过滤。
- `interrupt(sessionId)`：中断一个运行中的会话。

**interrupt 的诚实边界（锐评裁定）**：M2a 的 interrupt **只作用于本轮进程内的活动会话**（单进程单会话），不是"跨 workspace 中断另一个进程"。M1 的 `App` 接口没有 `interrupt`，`runSession` 的 while 循环没有取消原语——所以 M2a 要落地 interrupt，**必须给 runSession 引入取消信号**（如 `AbortSignal`/cancel token，在每轮之间或工具调用边界检查），这是一个**新的可中断机制**，不是"调用既有 interrupt"。**不得用"M1 已有语义"含糊掩盖这个空洞。**

> 若后续要有"跨 workspace 中断"，那需要先有能枚举多个 app/session 的 `SessionManager`（M2a 不引入，留 M4 跨进程或明确扩展时）。M2a 明确：interrupt 是单进程内取消。

**M2a 不做**：`send_to_session`（向任意会话发消息）、`spawn_agent`（拉起新会话）。这两样是"管家主动动别人"，涉权威分级，留 M2b。

---

## 3. M2b（预留，不实现）：管家权威模型

在实现管家能动性前，必须先写清**权威模型**（DSH 回避的深水区）。草案方向（来自 cordis-agent-design.md §3.6）：

| 权威 | 能做 |
|---|---|
| 用户 | 最高——任何操作 |
| 管家 | 中级——list/interrupt 全局；send/spawn 需父会话约束 |
| 普通父会话 | 仅限自己的子女 |

- `send_to_session`：**窄权威**——只有明确授权（如用户显式命令管家）才可发，否则拒绝。
- `spawn_agent`：**宽权威**——可拉起新会话，但必须声明归属（parent 链）。
- 所有主动行为都记录到 registry（可审计）。

**M2b 的感知反向通道**（DeskAware 式）：把环境事实（workspace、git 状态、日期、AGENTS.md 等）经"ack 反向通道"写回管家上下文，喂给管家判断。这是感知层的写通道原型。

**M2b 必须先写权威 spec，再给管家 LLM 大脑**——否则管家会滑向"给一个 LLM 盲目的能动性"。

---

## 4. 分阶段验收

### 4.1 M2a 验收（本轮）

- [ ] `SessionRegistry` 组件：`list/refresh/get`（惰性查询 EventStore + 内存索引）。
- [ ] 事件 fold：`Session.Created` → created_at；`Session.StepEnded` → status="settled"+updated_at；`Session.Interrupted` → status="interrupted"。
- [ ] 不做 SQLite 物化表（单进程小规模，懒查询+内存索引足够）；不引入 append 广播 hook。
- [ ] `interrupt(sessionId)`：给 `runSession` 加取消信号，能在运行中叫停（单进程内）。
- [ ] 按 workspace/status/projectId 过滤查询验证。
- [ ] 不引入 `send_to_session` / `spawn_agent`（guard：M2a 无自动能动性）。
- [ ] 独立锐评通过（关键：方案 B 正确、interrupt 真可中断、无反向依赖、表述诚实）。

### 4.2 M2b 预留（下一轮）

- [ ] 权威模型 spec（用户>管家>父会话；interrupt 宽、send/spawn 窄）。
- [ ] 管家特权 LLM 会话（pinned session，持 list/send/spawn/interrupt 工具）。
- [ ] `send_to_session` / `spawn_agent`（窄/宽权威 + 审计记录）。
- [ ] 感知反向通道（DeskAware 式环境事实写回）。
- [ ] 独立锐评（权威分级是否先写对再动手）。

---

## 5. 明确不做 / 边界

- **跨进程常驻 daemon**：M2a/M2b 都单进程（durable mailbox/lease 留 M4）。
- **DAG 调度**：M3。
- **UI（Web/Desktop）**：非 M2 目标，但 registry 的 list 查询可为 TUI/Web 复用。

---

## 6. 已裁定：registry 事件来源 = 方案 B（惰性查询）

**决定：M2a 用方案 B，不引入 `SessionBus` / append 广播。**（锐评已推翻最初的方案 A 倾向。）

- **方案 A（订阅/广播）**：registry 实时，但要求"每次 append 过 bus"，侵入被冻结的 EventStore 契约、append 调用点散落 8 处、且 M2a 没有 push 消费者（全是 list/get/interrupt 拉取）。**否决**。
- **方案 B（惰性查询）**：registry 对 EventStore 做 aggregateIds()+read()+fold，首查物化到内存索引。无 hook、不碰 store 契约、core 零改动、天然规避 "no scattered branch"。**采纳**。

> 未来若 M2b 管家 / TUI 真要实时 push：在 runtime 装配层用一个"发布式 EventStore 装饰器"包裹传给 runSession（append 成功后顺带 emit durable 事件），不碰 EventStore 接口、不碰 Session aggregate。这是增量行为，不是现在的 M2a。

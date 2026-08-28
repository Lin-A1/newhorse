# M3 规划：声明式 DAG 调度

日期：2026-08-28
状态：设计规划（未实现）—— 先对齐范围，锐评通过后再实现。

---

## 0. 结论先行

**M3 做"声明式 DAG 调度 subagent"**，目标是把 M2 的管家/子会话基座升级为"用户声明一张图，runtime 拓扑排序执行"的声明式编排。**这不是后台任务列表，也不是事后记录图**——图是执行规格，画在前面。

**核心差异化**（对比各家）：
- **opencode**：单层 BackgroundJob（fan-out 后各自 `waitForPromotion`），无图结构、无数据契约。
- **codex**：模型驱动 spawn + `agent-graph-store` 事后记录血缘（Open/Closed），图**不负责调度**。
- **claude code**：asyncRewake 单任务回灌。

**我们的 DAG**：显式依赖（`dependsOn`）+ 部分序调度 + 就绪队列 + 事件唤醒 + 节点数据契约 + 节点可独立选模型（成本平衡）。**图在前，调度据此执行。**

**真正的承重柱（锐评 R1/R3——"声明式"为何不是"后台任务换皮"）**：
1. **可重放的 DAG 聚合**（R1）：`DAGRun` 是事件溯源聚合（DAG.Declared/NodeStarted/.../Aborted），进程 kill 后能从 EventStore 重放重建整张图。后台任务的 job 列表是进程内内存，一死即失。**可重放 = 声明式；内存 Map = 后台任务。**
2. **被 runtime 强制校验的数据契约**（R3）：`consumes` 必须解析到祖先产出 + 缺失槽按策略 fail，不允许静默拿空。后台任务无数据契约（各 job 返回自取）。**被校验的契约 = 声明式；显式只是命名的隐式共享 = 换皮。**

> 缺了这两根柱子，M3 的"声明式"会被"fan-out + waitForPromotion 也能做部分序"一句话抹平。**这两条在 M3 必须先立。**

---

## 1. 核心概念（先钉死，防止被"后台任务"叙事模糊）

### 1.1 节点 = 一次 subagent 委派，不是模型 turn
- 一个节点 = 一个 `spawn_agent` 委派（一个子会话 + 一个任务描述 + 可选模型/工具）。
- 节点**不是**一次模型 turn 的逐条回放（非字面 transcript）。
- 节点执行产物 = 子会话的结算结果，进"节点产物槽"。

### 1.2 边 = 声明依赖，不是执行顺序
- 用户声明 `dependsOn: [nodeId]`，声明"数据/前置依赖"，**不声明执行时刻**。
- 执行顺序由 runtime 拓扑推导（topo sort），用户不写 `spawn A, wait, spawn B` 的指令式脚本。

### 1.3 执行模型 = 就绪队列 + 事件唤醒，无 join 阻塞
- 入度归零（所有依赖完成）的节点进就绪队列。
- 节点完成 → 事件唤醒其依赖者 → 更新就绪度 → 再入队。
- **主流程不被最慢节点拖住**：可并行的分支并行跑，一个分支失败不阻塞无关分支。

### 1.4 数据契约（显式，不隐式共享上下文污染）
- 上游节点产出写入命名产物槽（result bucket）。
- 下游节点声明消费哪些槽（`consumes: [slotId]`）。
- 槽是显式数据契约，避免"把所有 subagent 输出拼进同一上下文"的污染。

---

## 2. 与"后台任务"的区分（模糊防线的关键）

| | 后台任务（opencode BackgroundJob） | 我们（声明式 DAG） |
|---|---|---|
| 结构 | 单层任务列表 | 显式部分序图 |
| 顺序 | 按发射顺序隐式排序 | 依赖图拓扑排序 |
| 依赖 | 无（或仅并行执行） | 显式 `dependsOn` |
| 唤醒 | `waitForPromotion` 逐 job | 事件驱动，完成全链唤醒 |
| 数据 | 各自返回，无契约 | 节点产物槽，显式 `consumes` |
| 失败 | 单任务失败独立 | 部分失败隔离，可标记 retry/skip/abort |

**一句话防御词**：后台任务 = fan-out N 个 job 各自等；声明式 DAG = 显式部分序 + 数据契约 + 自动唤醒 + 部分失败隔离。**前者是"并行发任务"，后者是"声明并执行一张图"。**

---

## 3. 运行时（自研薄层）

### 3.1 核心类型（放置在 core/agent/dag）

```ts
interface DAGNode {
  id: string
  // 委派：spawn 一个子会话
  agent: AgentSpec                       // name/model/tools（节点可独立选模型）
  input?: string                         // 任务描述
  dependsOn?: string[]                   // 声明依赖
  consumes?: string[]                    // 消费哪些上游产物槽（数据契约）
  /** 本节点产出的槽名。缺省 = id（每节点默认单产物槽）。让先验校验可实现（R3）。 */
  produces?: string
}

interface DAGSpec {
  nodes: Record<string, DAGNode>
  entry?: string[]                       // 可选：入口节点（默认入度 0）
}

interface DAGRun {
  // DAGRun 是事件溯源聚合（R1：声明式可重放），不是内存 Map。
  // fold 以下事件重建整张图的状态/就绪度/槽。
}
```

**DAG 状态 = 事件溯源聚合（R1，声明式差异化的承重柱）**。DAGRun 从 log 折叠而来，进程 kill 后从 EventStore 重放重建整张图——这是"声明式 DAG" vs "进程内后台任务列表"的**硬界限**。

```ts
// DAG 聚合事件（落 (aggregate_id: dagId, seq, type, data)）
DAG.Declared     { dagId, spec }                     // 用户声明
DAG.NodeStarted  { dagId, nodeId, sessionId }        // 节点 = subagent 委派开始
DAG.NodeResolved { dagId, nodeId, slotId, outputRef }// 节点结算 -> 产物槽
DAG.NodeFailed   { dagId, nodeId, reason }
DAG.NodeSkipped  { dagId, nodeId, reason }
DAG.NodeAborted  { dagId, nodeId }                    // 节点被 abort-graph 中断（显式事件，不靠反推）
DAG.NodeRetried  { dagId, nodeId, attempt }           // failed -> pending 回退
DAG.Aborted      { dagId }                            // 图级 abort
```

**DAGRun 折叠算法（R1 承重柱的真立）**：DAGRun 是这些事件的 fold，`status/nodeId` 与就绪度/槽全部从 log 重建。

```ts
foldDAG(events):
  status := {}; results := {}; aborted := false; attempts := {}
  for e in events:
    DAG.Declared    -> spec := e.spec; 入度/边 := topo(spec)   // 边去重
    DAG.NodeStarted -> status[nodeId] = running; sessions[nodeId] = sessionId
    DAG.NodeResolved-> status[nodeId] = succeeded; results[slotId] = { nodeId, outputRef, status: succeeded }
    DAG.NodeFailed  -> status[nodeId] = failed; reason[nodeId] = reason
    DAG.NodeSkipped -> status[nodeId] = skipped
    DAG.NodeAborted -> status[nodeId] = aborted
    DAG.NodeRetried -> attempts[nodeId] = attempt; status[nodeId] = pending   // 回退 pending
    DAG.Aborted     -> aborted = true
  // 就绪度重算：对每个 running 依赖者，入度 = 它去重后的依赖数 - 已完成( succeeded )依赖数
  // 就绪门 = 入度归零 && status === pending && !aborted
  // 【级联终态（方案 B，R3 矛盾裁决）】对每个 pending 节点 D：
  //   若 D 的任一依赖终态为 非 succeeded（failed 不重试 / skipped / aborted），
  //   则 D 终态 = failed（或 skipped），NOT dispatched，不催 spawn。
  return { status, results, aborted }
```

**半途节点对账（进程死时"NodeStarted 无终态"）**：重放后若某节点 `status === running` 但无任何进程在跑（进程已死），DAGRun **将其视为 `aborted`（保底）**——因为它确实没结算。不重放副作用（符合 settlement durable）。重放时若该节点实则为"进程死了但子会话还在"，由子会话侧 `failInterruptedTools`（loop 已有）把未结算工具标 interrupted，DAG 侧只确认"未产出的节点不满足下游"。

> 关键：**节点有 `NodeAborted` 显式事件**（不用 `DAG.Aborted` + 无终态反推）；`retry` 有 `NodeRetried` 显式回退语义；就绪度/半途对账有 fold 规则。R1 因此**真立住**（可重放、可重建、可对账），不是"只列事件名"。

### 3.2 调度循环（无 join 阻塞）

**必须先 validate（R2），再调度。fail-fast 而非静默卡死：**

```ts
validate(spec):
  // R2.1 edge 去重：dependsOn 用 Set 归一化，入度按去重边数算
  //      （否则 dependsOn:['X','X'] 会让 Y 入度算 2 但被一次 -- 归零 -> 提前执行）
  // R2.2 环/未知引用/自环检测（Kahn 检测 + 所有引用存在），否则 fail-fast
```

**并发 dispatch 模型**（避免"串行 vs 逐层 join"二选一）：

```ts
runDAG(spec, deps):
  validate(spec)
  // 事件溯源：先落 DAG.Declared
  // 入度入图（去重后）；就绪队列 = 入度 0
  // dispatcher 常驻：worker 池从 ready 队列取节点（原子抢占 pending->running，防重复 dequeue）
  // 每节点:
  //   落 DAG.NodeStarted { sessionId }
  //   spawn subagent (exec node.agent, node.input)   // 节点独立模型
  //   完成后 -> resolve -> 落 DAG.NodeResolved { slotId, outputRef }
  //            -> 事件唤醒依赖者: 入度-- , 归零则入队（并发安全，用节点状态迁移做同步）
  // 单节点失败 -> 落 DAG.NodeFailed -> 按策略 retry/skip/abort-graph
```

- **无 join 阻塞**：ready 队列可并行，worker 池调度；完成回调泵依赖（单进程无需 pub/sub 总线，R6 术语澄清）。
- **每节点隔离**：节点各自是一个独立 subagent 会话（各自 sessionId/agent/model），经独立 `runSession` 运行，天然隔离 model/tools；共享经 `runDag` 内的 SlotStore。**不依赖运行时 DI scope**（Container.scope 在此不需要——节点隔离已由独立会话达成）。

### 3.3 节点状态机（R2.3 补 aborted）

```
pending -> running -> succeeded
                   -> failed   -> (retry | skipped | abort-graph)
                   -> aborted  // abort-graph 时 running 节点被 AbortSignal 中断（loop 已支持）
```

- **abort-graph（新矛盾①/② 裁决）**：
  - 落 `DAG.Aborted`；**dispatcher 立即停止认领新节点**（abort 后不再从 ready 队列取节点）。
  - 已 running 的节点发 AbortSignal（→ `NodeAborted`）；**尚未 claim 但已 ready 的节点归 pending → skipped**（`NodeSkipped`）；pending 全标 skipped。
  - 下游语义：abort 后**不再启动任何节点**，依赖者不会因跳过而"带空跑"——整图静默终止为 aborted。
- **被中断的节点绝不标 `failed`**（避免重放副作用，符合 "settlement durable / Tool execution interrupted"）。
- **retry**：尝试上限默认 2 + 幂等（retry 是新建子会话，非 resume 同一会话）；`NodeRetried` 把 failed → pending 再等 NodeStarted。
- **skip/失败 传播（方案 B：级联终态，不催 spawn，裁决新矛盾②）**：
  - 规则（**同一规则，同时写进 foldDAG 读模型与 dispatcher 运行时**）：
    > 若节点 D 的任一依赖的终态为 **非 succeeded**（failed 且不重试 / skipped / aborted），则 **D 不启动**，直接转 `failed`（或 `skipped`，按级联策略）。D 不产生事件之外的额外 spawn。
  - 就绪门保持"入度归零"，但**级联在归零前截断**：依赖非 succeeded → D 终态 = failed/skipped，不 dispatch。**绝无"永远 pending 无终态"的挂死路径**（否则违背 R2 fail-fast）。
  - 这符合"不带空跑"：下游不会带着缺失槽启动，也不会被静默挂起——要么明确 fail，要么明确 skipped。
  - 槽记为 `missing-slot`，但下游**因级联已不启动**，不触发"启动时校验"（那是方案 A 的路径，被否）。

### 3.4 节点数据契约（R3：最小契约必须现在定，非"以后再定"）

完整槽 schema 可推迟，但**最小契约 + 校验必须现在落**，否则"防上下文污染"是空话：

```ts
interface NodeResult {
  nodeId: string
  slotId: string              // = node.produces ?? node.id
  sessionId: string           // 该节点子会话
  outputRef: string           // 指向子会话结算结果（或产物槽引用）
  status: "succeeded" | "failed" | "skipped"
}
```

**强制校验（runDAG 必做）**：
- 每个节点 `produces`（缺省 = id），构成"祖先声明过的产出"清单，`validate()` 据此做**先验 fail-fast**：`consumes` 必须属于该节点祖先（依赖闭包）声明的产出，否则拒绝整图。
- 消费的 slot 缺失（被 skip / 失败）→ 下游 `missing-slot` 策略 fail，**不允许静默拿空**。
- 节点产物只在**确定性装配**里喂给下游（见 §4），不经模型"想"出来。

完整 schema（consumes 带类型/取子字段）推迟到需要时再做，但**上面的最小契约 + 校验这次就做**。

---

## 4. 节点独立模型（成本平衡）

每节点 `agent: { model }` 声明，节点用独立模型 spawn 子会话。**关键：成本平衡成立的前提是"多数叶子走便宜、少数决策点走贵"**（R6 补丁）：

- **默认继承 + costDown 策略**：`node.agent.model` 缺省继承父模型；`costDown` 策略（by role/by preset/by node）把未显式指定的节点落到便宜模型。给一个节点级默认，避免大量节点默默继承贵模型。
- **槽→node.input 是确定性装配**：下游接 `consumes` 的上下文由确定性模板直拼，**不设模型"读上游产物再组织"的步骤**（否则每跳一次贵 turn，抵消叶子省的）。
- 拓扑推导/就绪度/依赖解析是确定性代码，不是一次贵的 LLM turn——成本平衡没被调度模型抵消。
- 节点模型仍走四轴 Route + 单一 LLM 词汇（M1 已建），不绑定供应商。

---

## 5. 与既有 seam 的衔接（R4：如实声明，不假装复用）

- **spawn 基座（部分复用）**：`spawn_agent` / `SessionHub.spawn` 只持久化（落 Created+Spawned 返回 id），**不产生可运行的子会话**。DAG 的"并发驱动子会话"是**自建新增量**，不是复用。
- **DAG runtime 自建并发驱动层（核心新增）**：
  - 每个节点一个独立 `AbortController`（让 interrupt 单节点真生效）。
  - spawn child → admit node.input 到 child inbox → `runSession(child, { agent: node.agent, ... })` → 取结果 → 写槽 → 唤醒依赖者。
  - worker 池并发调度（非"复用 runSession 的串行循环"）。
- **registry**：复用 M2a 的 SessionRegistry 观察子会话树。
- **审计**：DAG run 注册进 registry，节点 settle 记审计（可观察/可干预）。
- **节点隔离**：每个节点是一个**独立 subagent 会话**（各自 sessionId/agent/model），经独立 `runSession` 运行——model/tools 天然隔离（无需运行时 DI scope）。共享（EventStore/registry/SlotStore）经 `runDag` 闭包或共享 service。**本实现不经 `Container.scope()`（独立会话已达成隔离）；此决策录入 docs。**
- **依赖方向**：DAG 类型放 core（纯拓扑/状态机），**调度器放 runtime**（要挂 hub/SessionHub）——防止 `hub` 依赖倒灌进 core（no-reverse-dependency）。

---

## 6. 边界与不做

- **不做**：跨进程 daemon 调度（M4）、磁盘 mailbox/lease（M4）。
- **单进程**：DAG run 与所有节点的子会话同进程（符合 M2 单 app 边界）。
- **不做"模型驱动自动构 DAG"**：图是用户声明的（或未来 LLM 辅助生成但须先声明），不是 codex 那种模型边跑边记。
- **管家干预**：DAG run 可被管家观察/中断（interrupt 单节点）——复用 M2b。

---

## 7. 分阶段验收

- [ ] `DAGSpec`/`DAGNode`/`DAGRun` 类型 + 拓扑排序（含 edge 去重、环/未知引用校验）。
- [ ] `DAGRun` 事件溯源可重放（DAG.Declared/NodeStarted/NodeResolved/...、进程 kill 后重建）。
- [ ] 就绪队列 + worker 池并发调度（多节点并行、无 join 阻塞、节点 AbortController）。
- [ ] 节点最小数据契约（`NodeResult` + `consumes` 校验 + missing-slot 策略）。
- [ ] 节点独立模型 spawn（costDown 默认策略 + 确定性槽装配）。
- [ ] 部分失败隔离（retry 上限/skip 传播/abort-graph 协调 running 节点）。
- [ ] 节点隔离（每节点独立 subagent 会话：各自 id/agent/model）+ SlotStore 共享。
- [ ] DAG run 可观察（registry + 审计）+ 可中断单节点。
- [ ] 独立锐评（重点是：非字面/非事后/非后台任务的区分是否成立、数据契约是否防污染、拓扑+就绪队列正确）。

### 7.1 最小差异化验收（钻石形图，证明"非后台任务"）

用**真实 tool + 受控 delay** 跑一个钻石形 `DAGSpec`（用 stub 模型省 token，但真走 invokeTool/delay 路径）：

```
        A(spec 快) ──→ B(消费A.slot) ──┐
                    └─→ C(慢) ─────────┴─→ D(贵模型 merge, consumes:[B,C])
```

断言（①-⑥ 必须全过）：
1. 顺序正确：D 只在 A/B/C 都 settle 后才跑。
2. **B 在 C 还没完成时已 complete**（no-join 的直接证据——单纯 `Promise.all(dag)` 反而是 join，证明不了它）。
3. 槽数据流干净：D 拿到 B、C 产出的 slot 而无拼接污染。
4. 受控 delay 的 tool 断言 wall-clock < 串行总和（证明真并行）。
5. abort-graph 中断一个 in-flight 慢节点，下游不再跑（aborted 态协调正确）。
6. **模拟重启后从 EventStore 重放重建整张图**：绑定 **durable EventStore**（SqliteEventStore 经 dataDir），跑完后"丢弃 DAGRun 内存聚合、从同 dataDir 重新 fold"→ 断言同上（D 仍正确产出、半途 running 节点被对账为保底态）。**密钥：用 durable store（MemoryEventStore 随进程消亡，测不了重放），"kill"表述为"丢弃内存聚合→重开 store fold"。**

---

## 8. 核心风险（提前声）

1. **被"后台任务"叙事模糊**：必须在实现前把这句钉死——声明式 DAG = 部分序 + 数据契约 + 自动唤醒 + 隔离失败；后台任务 = 并行发任务。用 §2 表格防御。
2. **数据契约设计**：产物槽/consumes（§3.4）用 `produces ?? id` 让先验校验可实现，完整 schema 推迟，但"运行时不静默拿空"必须这次做。
3. **单 app 边界**：DAG 节点作为 subagent 需同进程可 spawn——依赖 M2b 的 SessionHub.spawn 真生效（当前它真落事件）。跨进程调度是 M4。
4. **DAG 事件命名空间**：DAG 聚合事件（aggregate_id: dagId）需在 schema 的 `AggregateType` 加 `"dag"`（当前只有 session/audit），否则寄生在 session 命名空间下。实现前定。

---

## 9. 独立锐评要求

实现前，本 spec 先经独立 subagent 锐评，重点审：
- 声明式 DAG vs 后台任务的区分是否真正成立（会不会被"fan-out + wait"一句话抹平）。
- 拓扑排序 + 就绪队列 + 事件唤醒是否正确、无竞态。
- 节点数据契约（产物槽/consumes）是否防上下文污染。
- 节点独立模型是否真降低成本（成本平衡主张）。
- 部分失败隔离语义（retry/skip/abort）是否自洽。

**必须锐评通过、findings 清零后才实现。**

# v2 路线图（Phase 计划）

> 状态：**规划（2026-08-29）** — 这是对 `AGENTS.md` "Current Direction" 的操作化。方向定调：**runtime server 优先、模型调度为主入口、声明式 DAG 为图谱形态、记忆/技能预留 schema**。每阶段标注"对到哪一差异点"、涉及文件、验收。

---

## Phase 0 — 现状基线（已完成）

- 单会话闭环：CLI `--prompt` → `createApp` → admission → turn → tool → settlement → 重启 re-attach。
- 差异点：模型无关（词汇表 + 四轴 Route + 3 协议 + 错误分类）、事件溯源（SQLite 原子 seq）、DAG 拓扑 + 事件驱动 pump + cost-down model 选择、execpolicy（14 轮审查）、插件注册面（五类 + 目录发现，含 skills 发现层）。
- 已知缺口（`docs/` §17）：子会话 `location: ""` 无 AGENTS.md 继承；`spawn_agent` 创建死会话；hub `interrupt`/`send` 为 stub；DAG 无 CLI 入口、slots 仅内存；compaction / usage 持久化缺失；agents/commands/hooks/skills 有注册无消费者；记忆无预留。

---

## Phase 1 — Runtime server（优先）

**目标**：把 `createApp` 暴露成 transport-无关的 HTTP + SSE 边界，shells（CLI/TUI/desktop/SDK）只消费它。

**做什么**
- 新包 `packages/server`（或 runtime 内的 server 模块，视 transport 归属定）。
- 端点（初始）：
  - `POST /session/:id/prompt` — 调用 `app.prompt(text, principal)`，SSE 流事件（`text`/`reasoning`/`tool`/`tool-result`/`step`/`done`/`error`）。复用现有 `onEvent` fan-out。
  - `POST /session/:id/steer` — 调用 `app.steer(text)`（`delivery:"steer"`，下个安全边界提升；与 prompt 语义不同，勿混）。
  - `GET /session/:id` — `app.resume()` 投影。
  - `GET /sessions` — `listSessions(query)`。
  - `GET /audit` — `audit(actorSessionId?)`。
  - `GET /session/:id/events` — 可选的 log 尾随（重放 StoredEvents）。
  - `POST /session/:id/interrupt` — `app.interrupt()`（单进程已可用；跨进程/spawn 为未来）。
- 传输层仅做 parse/headers/stream；领域逻辑全在 `createApp`。
- 配置文件允许 transport（CLI）注入 `provider/model/workspace/dataDir/execPolicy onApprove`（TUI 或 server 凭证）。

**对到哪一差异点**：#5（usable + extensible）、#2（远程/长时运行）。
**涉及文件**：`packages/runtime`（仅导出面，不改核心）、新 `packages/server`。
**验收**：CLI 改为消费 server（或不变，另起 `server` bin）；SSE 流可被 curl 消费；重启后 resume 可用。

---

## Phase 2 — 真子会话基座（"大脑"前置，先于编排；紧跟 Phase 1）

**为什么在 Phase 1 后**：Phase 1 先把 `createApp` 暴露成 server 边界（多会话/远程可用），Phase 2 则补上编排的真正地基——否则 server 只是单会话远程 prompt，子代理仍是僵尸。排序：先有外壳边界，再让子代理活过来。

**目标**：`spawn` 出的会话是**活的、被驱动的**、**继承工作区上下文**、**结果回填父会话**。这是模型调度与 DAG 的共同地基。

**做什么**
1. **workspace 继承**（S）：`hub.spawn` 与 `dag-runner` 的 `Session.Created` 写入 `location: parentWorkspace`（而非 `""`）；把 `app.ts:220-234` 的 system-context 注入提取成可复用 helper，供子会话首次 turn 前调用。
2. **驱动子会话**（S-M）：`app.prompt` 后，spawn 出一个后台 `runSession`（process-local activation map：`sessionId → {abort(), kick()}`）；子会话真正跑完。
3. **结果回填**（S-M）：子会话完成后，经父会话 inbox 投递一条 `Prompted` 事件（`principal: "parent"`，现有字段，不新增 `source`），父会话被唤醒；`task_id` 指到子会话聚合。
4. **`spawn_agent` / `followup_task` 工具真正工作**：当前 `spawn_agent` 只写 `Session.Created`+`Spawned` 死行——改为走 1-3 的基座。`send_message` 先行；`interrupt` 用 activation map 实现。

**对到哪一差异点**：#1（双轨基座）、#2（continuable child）、#3（cost-down 生效）。
**涉及文件**：`packages/runtime/{hub.ts,app.ts}`、`packages/core/src/agent/{loop.ts,runner.ts}`（如需 `resolveClient`/`signal` 传递）、`packages/runtime/src/dag-runner.ts`。
**验收**：`createApp().prompt("spawn a child...")` → 子会话有 system 上下文（含 Workdir + AGENTS.md）→ 真正运行 → 结果回父会话；`hub.spawn` 后 `registry.listSessions` 可见真驱动会话。

---

## Phase 3 — 模型编排工具 + DAG 子命令（同一基座）

**目标**：模型是调度器（`spawn_agent`/`send_message`/`followup_task`/`wait`），声明式 DAG 是批/planned 形态。

**做什么**
- 编排工具对（对模型开放）：`spawn_agent`（已存在，改接基座）、`send_message`（queue-only）、`followup_task`（queue + trigger turn）、`wait_agent`（clamped timeout）。这些是 codex `send_message`/`followup_task`/`wait` 模式的移植。
- `DAG 子命令`：`newhorse dag <spec.json>`（或 server 端点 `POST /dag/run`）→ 加载 `DAGSpec` → `runDag`。这是把已实现但只有 API 的 DAG 暴露给用户。
- **DAG 持久化 slot**：把 `NodeResolved` 的 `output`（string）写进事件（而非仅 in-memory `Map`），`replayDag` → 新增 `resumeDag`（从 fold 种子 slot store 后重泵 pending 节点）。

**对到哪一差异点**：#1（声明式 + 模型驱动双轨、真正可复用）、#3（每节点/每 spawn 模型）。
**涉及文件**：`packages/runtime/src/dag-runner.ts`（slot 持久化 + resume）、`packages/cli/src/index.ts`（`dag` 子命令）、`packages/runtime/src/butler.ts`（工具）。
**验收**：`newhorse dag graph.json` 跑通并可在 server 里 `GET /dag/:id` 看状态；crash 后 `resumeDag` 继续而非仅"看尸体"。

---

## Phase 4 — 记忆 + 技能 + 成本可见

**目标**：长时运行不撞墙；可复用记忆；技能三级披露真正可用；成本可见。

**做什么**
1. **记忆预留（schema，S）**：`schema/event.ts` 加 `Session.MemoryRead` / `Session.MemoryWrite`；`schema/session.ts` 加 `memory` kind 消息；`core/registry.ts` fold 出可查询读端；**索引层（嵌入/向量）是 pluggable provider**（像 `EventStore` 可换后端那样），核心只做事件溯源索引。
2. **记忆工具（M4 内）**：`memory_read` / `memory_write` 走 Tool 契约；采纳 mem0 的增量提取（取最近消息 + 检索已有 → `{text, old_memory, event}`）+ 整数映射 ID 防幻觉。
3. **技能加载工具**：`discoverSkills` → 内置 `skill` 工具（`execute({name, full?})`），目录只露 name/description，body 按需取，`references/`/`scripts/` 懒加载。
4. **成本可见**：`Session.StepEnded` 持久化 `usage`（input/cache/output tokens + cost）；CLI/`PromptResult` 展示；cost-down 结果可核对。
5. **步数提示**：把剩余步数写进用户消息（非 system，避免破坏 Anthropic 缓存锚点）而非代码硬墙。

**对到哪一差异点**：#2（本地 compaction + 长时）、#3（成本可见）、#5（技能披露）。
**涉及文件**：`packages/schema/src/{event.ts,session.ts}`、`packages/core/src/{session/loop.ts?}`（usage 持久化）、`packages/runtime/src/tools/{skill.ts,memory.ts?}`。
**验收**：长会话到上限前模型被提示；记忆读/写事件可重放；`skill get` 返回正文而不是注册了没人用；`PromptResult` 带成本字段。

---

## Phase 5 — 本地 compaction + SessionManager（深水区）

**目标**：长时运行的诚实边界；跨会话效果投递。

- **compaction**（L）：本地事件溯源式总结边界——emit `Session.Compacted` + compaction user message（模型可见 ⟺ logged）；触发 = 配置化 token 上限或 `maxSteps` 临近。**缓存安全**：总结进 user 消息，不碰 `body.system` 锚点。
- **SessionManager**（M-L）：真正的跨会话协调（wake-coalescing、per-session 序列）；`hub.interrupt/send` 从 stub 变真实；模型编排工具落地后自然需要。

**对到哪一差异点**：#2（长时间不撞墙）、#1/#3（多会话编排）。

---

## 明确不做（近期）

- **插件 TS 代码加载**：无信任/沙箱模型前不做（那是远程代码执行漏洞）；JSON stub 抛错是诚实基线。
- **独立 `AgentGraphStore`**：newhorse 的 DAG aggregate + `Session.Spawned` + registry fold 已是血缘；第二个 store 重复。
- **DSH inbox-as-event-stream**：会破坏"保持 durable prompt 接纳与模型执行分离"。
- **全 Cordis/opencode runtime**：已被正确拒绝（"非架构 hostage"）。
- **DeskAware/mem0 整体机制**：land 时作为普通 Tool 建在现有 seams 上。

## Source of truth

- 设计决策：`docs/core-technology-notes.md`
- 各机制计划：`specs/v2/*.md`（状态头已标 implement/deferred）
- 当前已实现/占位：`docs/core-technology-notes.md` §17

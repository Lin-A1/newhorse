# Agent Runtime (M1) 技术规格

> 状态：**已实现（M1）** — 三 seam + 单会话 CLI 闭环已落地并通过端到端冒烟；实现决策见 `docs/core-technology-notes.md` §1-§9。
> 范围：M1 骨架 —— session / agent / llm 三个 seam + 单会话 CLI 跑通。
> 上游参照：`cordis-agent-design.md` §3，偏好 codex/claude agent runtime + opencode 外壳。
> 目标：先把「一个 prompt 从 admission → turn → 工具 → 结算」的闭环跑通，结构上为 M2 管家 / M3 DAG 留出 seam。
> 定位原则：**不追求"证明差异性"，追求好用 + 可拓展。各家精华全取，糟粕全弃。** 本文所有"借鉴/参照/对齐"都指向明确的出处，不自称原创。

---

## 0. 借鉴全景（我们要什么、弃什么）

一句话定位：**runtime 用 DSH 的 seam 三段式骨架（可拓展）；agent 行为学 codex（响应好）；外壳用 opencode（多模型表现好）；工程规范性向 claude code 看齐（工程能力高）；避免 codex 的生态过拟合、claude code 的排他、DSH 的 runtime 过浅。**

| 来源 | 它强在哪 | 我们取什么 | 它弱在哪 | 我们弃什么 |
|---|---|---|---|---|
| **opencode** | 多模型表现好，TUI/server 外壳解耦，v2 有 durable inbox / event-sourcing / BackgroundJob | 外壳解耦（CLI/server/SDK）、admission inbox、四轴 Route、嵌入式 SDK | **agent runtime 无法 DAG 调度 subagent**（调度在它 runtime 内，锁死自定义） | 不 fork，调度层自研（见 M3），不绑其 runtime |
| **codex** | 响应形态好，spawn/邮箱/角色通信全 | 响应范式、spawn 通信语义（send_message/close_agent）、ThreadStore 中性存储、execpolicy | **对 response API 范式过拟合**，上下文压缩等调**远端 API**，依赖自身生态 | 不依赖它生态（本地的上下文/压缩、本地的存储），不用它 Rust 内核 |
| **claude code** | 工程能力极高，目录即注册面、双类型 hook、asyncRewake、skill 三级披露 | 目录注册发现、hook 控制流、asyncRewake 主循环、skill 加载策略 | 表现形式差、**极度排斥其他品牌模型** | 不锁生态，接多供应商；表达不佳靠 codex/opencode 响应范式补 |
| **DSH (deepseek-harness)** | 生态与可拓展性极强，seam 三段式、"everything is a plugin"，continuable child | seam 三段式骨架、session log 单一事实源、continuable、delegated policy | **runtime 做得太浅**，60+ 包深度耦合抽不出干净块 | 不 fork、不搬代码；重写一个真正堪用的薄 runtime |
| **社区/生态库** | 敏捷的交互/分发范式（oh-my-opencode、open-code-review、agent-browser、mem0、DeskAware 等） | 配置 handler 收敛点、确定性工程与 LLM 分层、skill 即接口/CLI 即内容、记忆多信号融合、感知分层 | 单点工具，不成完整框架 | 只参照其模式，不整体并入 |

**给 M1 的总纲**：三 seam 骨架抄 DSH 的语义（完整 seam + 可撤销）；会话/消息基础设施抄 opencode v2（inbox + 事件溯源）；agent 响应与 spawn 语义抄 codex；外壳解耦抄 opencode。**调度（DAG）是自研差异化位，但本轮 M1 不做，只留 seam**。所有抄来的东西在文档里标注出处，不冒充原创。

---

## 1. 分层与职责边界

```
┌──────────────────────────────────────────────────────┐
│  CLI 外壳（opencode 式：command / server / SDK 解耦）  │
├──────────────────────────────────────────────────────┤
│  Agent Runtime（薄骨架 + 自研调度位）             │
│    session seam · agent seam · llm seam          │
├──────────────────────────────────────────────────────┤
│  Cordis 插件内核（自实现 seam 三段式，不引 @cordis 运行时）│
└──────────────────────────────────────────────────────┘
```

M1 只要求三 seam 各有一个能跑的实例，**不做**：管家、DAG、跨进程、Web UI。但每个 seam 的接口都要朝「可替换 / 可插拔」设计，避免 M2/M3 回头补。

核心铁律（来自 DSH，原样采用）：

- **model-visible ⟺ logged**：只有写进 append-only session log 的内容才会进模型可见上下文；一切模型可见内容必须先落日志。
- **complete seam**：每个 seam = Service Definition + Provider + Consumer 三段，注册即 effect，返回 disposer，可撤销。
- **admit 幂等**：prompt 先入 admission 区，再事务式提升；重复 admit 返回同一 receipt，`steer`/`queue` 两种交付语义显式区分。

---

## 2. Session Seam

### 2.1 数据模型

持久化后端可换，M1 用 SQLite 起步，但访问层要做成中性 trait（参照 codex `ThreadStore`）。

```
session          (id, location, workspace_id, created_at, ...)
session_input    (id, session_id, seq, prompt, delivery, admitted_at)
message          (id, session_id, seq, role, content, model, provider, type)
session_event    (aggregate_id, seq, type, data)
```

- `session_event` 是事件溯源底座：`(aggregate_id, seq, type, data)`。
- durable 与 live-only delta 显式分离：UI 追 cursor 即可。
- `session_input` 是 durable admission inbox（吸收 opencode v2 `input.ts`）。

### 2.2 Admission（幂等 admit + 交付语义）

```
admit({ id?, sessionID, prompt, delivery?, resume? })
  -> 省略 id 生成内部 message ID
  -> 提供 id 且该 session 无此 id 时写入 durable inbox 行
  -> exact reuse 返回同一 admission receipt
  -> 同 messageID 用于另一 session/prompt/delivery 时失败（冲突检测）
  -> resume 省略或 true：admission 后调度执行
  -> resume false：仅 admit 不回执
```

交付语义（对齐 opencode v2 `steer`/`queue`）：

| 语义 | 行为 |
|---|---|
| `steer` | 在下一轮组装前优先级提升（不打断当前正在流式的响应） |
| `queue` | 追加到待处理队列，按序处理 |

- admission 事件（`PromptAdmitted`）先持久化并投影，让客户端在提升前就能看到排队中的输入。
- `admittedSeq` 是 `PromptAdmitted` 的持久事件序号，客户端可用它表达「已接收但尚未可见」的输入。
- 提升到可见历史（`Prompted`）由 runner 在真正发送给模型前的安全边界原子写入。

### 2.3 Execution 路由

```
SessionExecution.resume(sessionID)
  -> SessionStore.get(sessionID)
  -> LocationServiceMap.get(session.location)
  -> SessionRunner.run({ sessionID, force? })
```

- `SessionExecution` 与读端 `SessionStore` 进程级全局。
- `SessionRunner`、catalog、model resolver、tool registry、permission、filesystem 按 Location 缓存。
- 不传 Session ID 的层一律不取 session；省略 `Location.workspaceID` = 隐式本地放置。

---

## 3. Agent Seam

参照：codex `spawn_agent`/`followup_task`/`send_message`/`close_agent` + `InterAgentCommunication` 邮箱 + `.agent-role.toml`；DSH continuable child；Claude Code asyncRewake。

### 3.1 Agent = 会话 + inbox + turn 循环

- `Agent = Session + FIFO inbox + turn 循环`。
- Agent 不是常驻对象，是「会话 + 驱动方式」的封装；M1 只有前台同步 run。
- M2/M3 在此基础上加「Activation 常驻 / 冷恢复」的 continuable 语义与 spawn 通信。

### 3.2 Spawn / 恢复的原语（M1 只定义接口，不全实现）

接口先行，语义对齐 codex，M1 内仅 `spawn_agent` 同步版本可用：

```
spawn_agent({ agent, workspace, preset, model })
followup_task(task_id)      // 后台任务回注结果
send_message(agent_id, msg)
close_agent(agent_id)
```

- `task_id` 支持续跑（非阻塞背景执行的 hook 位，M1 留接口）。
- 角色配置 `.agent-role.toml`：声明 roles/authority/preset，供 M2 管家与 M3 DAG 读取。

### 3.2.1 subagent 独立模型策略（成本平衡，可开关）

**目的**：subagent 默认继承父 agent 的模型；但可以为一次委派单独指定一个更便宜的模型，把成本压在子任务上，只在关键节点用贵模型。这是 DAG 调度 subagent 的核心价值之一——声明式地在图上给每个节点配模型，是 codex 做不到的（codex spawn 是同一模型 turn 决定一切，难以在子任务上串行降级成本）。

- **默认继承**：`spawn_agent({ agent, workspace, preset, model? })`，`model` 省略时继承父 agent 当前模型。
- **独立指定**：`model` 提供时，该 subagent 用独立模型起一个独立 turn；parent 不因 child 的模型而改变。
- **开关**：默认行为（继承）可通过配置/策略切换。打开「cost-down」策略时，未显式指定的 subagent 落到预设的便宜模型（by role / by preset / by node）。
- **不绑定供应商**：independent model 仍走四轴 Route + 单一 LLM 词汇，任何可注册的 provider 都可用，不受父 agent 绑定约束。

```text
spawn_agent({ agent, preset, model?: ModelRef, costDown?: boolean })
  -> model 省略 && costDown 不开启 : 继承 parent.model
  -> model 省略 && costDown 开启     : 按 role/preset 落便宜型号
  -> model 提供                    : 用该 model（独立 turn，不改 parent）
```

### 3.3 Turn 循环（Claude Code 双类型 hook + asyncRewake 参照）

turn 循环从 admission 开始，到结算结束：

```
loop:
  1. 提升 eligible input（steer 优先 / queue 顺序）
  2. 期望所需上下文 → 组装 provider request
  3. 调 asyncRewake 可选的 PostToolUse / Stop 后台处理
  4. 流式接收 assistant / reasoning / tool_calls
  5. 逐条落实工具（结构化子任务），await 每条 fiber
  6. 结算：投影 tool settlement，写回 session log
  7. 若仍有工具结果待处理 → 重新组装上下文，继续下一轮
```

- 每个 provider turn 只发一次 `llm.stream(request)`。
- 在 provider stream 关闭后、继续下一轮前，**重载一次**投影历史。
- 新 user input 提升会重置所选 agent 的 provider-turn 配额；同一边界多次 steer 只重置一次（对齐 opencode v2）。
- 工具结算事件携带所属 assistant message ID，因为 provider 本地 call ID 跨 turn 可能重复。

### 3.4 恢复与中断

- 跨进程仍处于 `running` 的本地 tool：在下一次组装前**durable 失败**为 `Tool execution interrupted`，绝不静默重放被弃的副作用（对齐 opencode v2）。
- `interrupt(sessionID)`：中断当前进程内活跃执行，等待 runner 清理与结算，清掉已合并的 follow-up wake，但保留 durable inbox 行供后续 wake/resume；空转或缺失 session 为 no-op。
- M1 无跨进程 mailbox / lease，单进程内实现即可；跨进程做标记为 M4。

---

## 4. LLM Seam

### 4.1 四轴 Route（对齐 opencode v2）

```
route = {
  Protocol,   // openai / anthropic / ...
  Endpoint,   // base url
  Auth,       // key / oauth / provider
  Framing,    // stream / sse / json
}
```

- 第一天多供应商：OpenAI 兼容 + Anthropic 兼容两个 adapter 起步。
- provider 注册在 seam 上，**无默认绑定**；compile 与执行分离。
- compile 结果是一次性组装，执行独立。

### 4.2 嵌入式 SDK（同 HTTP 边界零分叉）

参照 opencode v2 `packages/sdk`：内存 HttpRouter 包装成 `fetch`，网络 / 嵌入式共用同一 HTTP 边界，零分叉。M1 保留该解耦位，但只做 shell 部分（见 §5）。

---

## 5. CLI 外壳（opencode 式解耦）

「外壳」指 user 偏好的 opencode 形态：CLI 命令 / server / SDK 三层解耦。

### 5.1 命名约定（对齐本仓库 specs/v2 既有文件）

新增文件路径：`specs/v2/agent-runtime.md`（本文件），后续可补 `cli.md`、`server.md`、`sdk.md`。

### 5.2 三个入口（M1 只保证 CLI 单会话跑通）

```
cli     -> 单会话交互（M1 完成目标）
server  -> `serve` + OpenAPI + 远程调用（M2/M3 需要时补）
sdk     -> 嵌入式调用（同 HTTP 边界）
```

- 职责：CLI/server/SDK 只做 transport，不装领域逻辑；领域逻辑在 Agent Runtime。
- TUI 与 Bun/Effect 深度绑定的做法（opencode v2）**复制形态、不透传绑定**，避免重蹈抽包即重写。

### 5.3 M1 验收（单会话闭环）

```
$ newhorse  (或者子命令)
> 输入 prompt → admission → turn → 工具 → 结算 → 输出
> Ctrl-C → interrupt/清理
> 重启 → session 与 inbox 可恢复
```

---

## 6. 插件注册面（M1 最小集）

M1 插件注册面放宽到五样（对比 opencode 只注册 tool、codex 只声明资源）：

```
tools + agents + commands + hooks + providers
```

外加 codex 式纯声明资源包（skills / mcp / apps）经同一注册面挂载，兼容多生态 manifest。

- 支持显式注册 + Claude Code 式目录即注册面（约定目录自动发现），两者并存。
- 注册即 effect、可撤销（Cordis seam 语义）。

---

## 7. 风险与 M1 裁剪

| 风险 | M1 处理 |
|---|---|
| DAG 与后台任务叙事混淆 | M1 不做 DAG，只给 spawn/task_id 接口 |
| 管家权威模型不确定 | M1 不做管家，权限只在系统提示 + delegated policy 雏形 |
| 跨进程/常驻未解 | M1 单进程；durable mailbox/lease 标记 M4 |
| 与 codex/claude 范式撞名 | 命名用 `newhorse` 自身命名避免歧义（见 §8） |

---

## 8. 命名决策

- 项目对外对内一律叫 `newhorse`，不再另起代号。
- 项目名与上游 `@cordis`（Koishi 生态插件内核）无关——只用其 seam 三段式**语义**，不引其运行时，避免命名混淆也避免生态负担。如需引完整 `@cordis` 内核，判断标准只有一个：出现真实需求要跑别人(Koishi/DSH)生态插件。

---

## 9. M1 落地清单（Checklist）

- [ ] seam 三段式最小骨架（自实现容器，Cordis 语义）
- [ ] session seam：SQLite 存储 + trait 抽象 + admission inbox + 幂等 admit
- [ ] agent seam：会话 + inbox + turn 循环（同步）+ spawn/task_id 接口
- [ ] llm seam：OpenAI 兼容 + Anthropic 兼容两 adapter + 四轴 Route + 嵌入式 SDK 解耦位
- [ ] CLI 外壳：单会话交互跑通 + interrupt + 会话恢复
- [ ] 插件注册面工具集：tools + agents + commands + hooks + providers
- [ ] 验收：`model-visible ⟺ logged` 铁律验证、admit 幂等测试、单会话闭环 handoff

## 10. 后续挂钩（非 M1）

- M2：Global Session Registry + 管家特权会话 + list/send/spawn 三工具 + 感知反向通道。
- M3：声明式 DAG 调度层（节点 = subagent 委派，节点可独立选模型做成本平衡）+ discuss 多 agent 讨论 + 背景执行（promotion/asyncRewake）。
- M4：权限模型细化（execpolicy 自举 + delegated policy）、Web UI、持久化后端可换、多 marketplace 分发。

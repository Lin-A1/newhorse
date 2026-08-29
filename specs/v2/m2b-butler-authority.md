# M2b Spec：管家与权威模型

日期：2026-08-28
状态：**已实现（M2b 权威模型）** — 完整但管工具集（list_sessions/spawn_agent/interrupt/send_to_session）+ `ToolCtx.caller` 注入 + 审计聚合已落地；跨会话效果（interrupt/send 真投递）与全 SessionManager 属 M4。实现决策见 `docs/core-technology-notes.md` §11。

---

## 0. 定位

**管家（butler）= 一个持有多余工具的特权 LLM 会话。** 它本身是一个普通 agent 会话，只是工具集更宽（list_sessions / send_to_session / spawn_agent / interrupt 等），并且能跨会话、跨 workspace 观察与干预。它是 M2 的差异化头牌。

**为什么这是深水区**：DSH 刻意回避 host-user continuation（"需要具体认证交互"）。管家若没有清晰的权威模型，会滑向"给一个 LLM 对别的会话盲目的能动性"。**本 spec 先在纸面上把权威分级、允许/拒绝规则、可审计性定死，再允许实现。**

---

## 1. 权威分级（三档，严格偏序）

| 权威 | 来源 | 能做 |
|---|---|---|
| `user` | 用户显式命令/配置 | 最高——任何操作 |
| `butler` | 管家会话自身的上下文 | 中——list/observe 全局；send/spawn 需满足父链约束 |
| `parent` | 普通父会话（spawn 它的那个） | 低——只能对自己的直接子会话做窄操作 |

**严格偏序**：`user > butler > parent`。一个操作是否允许，取决于**触发者权威 ≥ 该操作所需权威**。

关键判定原则（防滥用）：
1. **管家不等于用户**。管家是 LLM，它的"意愿"不是"授权"。管家想 `send_to_session` 到任意会话，需要**用户显式授权**（如用户命令"管家，把 X 发给 Y"），否则拒绝。**默认拒绝、显式授权才放行。**
2. **权威是"确认触发者等级"，不是"确认内容对错"**。即：我们校验"谁在发起"（触发者身份 + 等级），不校验"内容是否合理"（那是 LLM 判断，不是运行时）。运行时不裁决内容，只裁决**身份权限**。
3. **父链约束**：`parent` 权威只能作用于**自己的直接子会话**（spawn 时登记的 parentId）。`butler` 要 send/spawn 跨会话时，目标必须是`butler`自己的子会话，或用户显式指定。
4. **一切主动操作必须可审计**：append 一条不可变审计事件（谁、何时、对哪个 session、做什么、被允许还是拒绝），进 registry 可查。

---

## 2. 工具集合与权威要求

### 2.1 `list_sessions`（观察）—— 权威：butler 即可
- 查询 registry 投影（M2a 已提供 list/refresh）。
- **只读，任何会话都可**。不涉及"动别人"，butler 级即可。
- 无副作用，无需审计为"主动操作"（但可记录访问日志）。

### 2.2 `interrupt`（叫停）—— **宽权威：butler 可对任意会话；parent 仅限直接子会话**
- 中断一个运行中的会话（M2a 已实现 per-run cancel）。
- **权威按触发者区分（消除 §3.2 的归属矛盾）**：
  - `butler` 触发 → **宽权威**，可中断任意会话（安全阀，防失控）。
  - `parent` 触发 → **窄权威**，仅中断自己的**直接子会话**（`target.parentId === caller.sessionId`）。
  - `user` 触发 → 任意。
- 为什么 butler 宽：interrupt 是**安全阀**，只减少能动性、不增加；允许 butler 对任何它观察到的会话叫停，防止某个子会话失控后没人能停。这符合 M2a 定下的"interrupt 用宽权威、内容投递用窄权威"。
- **target 解不出 → 一律拒绝**（见 §3.2 通用规则）。
- 审计：记录"butler 中断了 session X"。

### 2.3 `spawn_agent`（拉起新会话）—— **宽权威但必须声明归属**
- 需要一个"管理员父"。触发者必须是但它的发起者。
- **关键：parent 链必须可审计且不悬空**。spawn 时登记 `parentId = 触发者 sessionId`。新会话成为一个可被追溯的孩子。
- `butler` 或 `user` 都能 spawn；spawn 出的会话**自动成为 spawner 的子会话**。
- 审计：记录 spawner、新会话 id、parentId、用途（如果给的理由）。

### 2.4 `send_to_session`（向任意会话发消息）—— **窄权威：最危险**
- **默认拒绝**，除非：a) 触发者是 `user`（用户显式命令），或 b) 目标是触发者的直接子会话（`parent` 对自己孩子）。**butler 无用户显式授权时一律拒绝**（不同于 interrupt——send 能改变目标状态，必须窄权威）。
- **与 interrupt 形成对照**：interrupt 只减不增（butler 宽），send 能增（butler 窄，默认拒）。
- **兜底**：`target` 解不出（目标会话不存在）→ 拒绝 + 审计。
- 审计：记录**谁、对哪个 session、内容摘要、允许/拒绝**。拒绝也记录（可审计的拒绝）。

---

## 3. 权威判定如何落地（实现骨架，先定后做）

> **关键修正（锐评 A1/A2）**：`Initiator` 绝不能由调用方/LLM 自报——任何 LLM 都能 `{kind:"user"}` 拿到最高权威，"默认拒绝"就成文字承诺。**Initiator 必须由运行时在受信边界注入，user 权威必须走 transport 打的 principal，而非 LLM 上下文推断。**

### 3.1 触发者身份（initiator —— 由运行时注入，不可由调用方构造）

`Initiator` 是**运行时依据 run 上下文 + admission principal 派生**的结果，工具/LLM 无法构造它。它作为工具的**第二个参数**由 loop 注入（见 §3.4），不是 input payload 里的字段。

```ts
type Initiator =
  | { readonly kind: "user" }                                    // 仅当 transport 为该 prompt 打了 user principal
  | { readonly kind: "butler"; readonly sessionId: string }      // 但管会话
  | { readonly kind: "parent"; readonly sessionId: string }      // 某个父会话（spawn 它的人）
```

**信任获取（关键，不是自报）**：
- `butler` / `parent`：**天然可信**——loop 在运行任一 session 时本就持有该 session 的 `caller sessionId`（`runSession` 的 `opts.sessionId`），把它注入为工具调用的 caller 即可。LLM 无法伪造，因为它不在 payload 里，而在受信的调用上下文里。
- `user`：**不能从但管会话的 prompt 文本里读**。"用户说想发 X"只是一条 prompt，和普通 prompt 无差别。user 权威只能由 **transport 层在 admission 时打 principal 戳**：人在 TTY 键入的 prompt 打 `principal:"user"`；但管/agent 产生的 prompt 打 `principal:"butler"`（存进 `PromptAdmitted` 事件）。**只有该 prompt 的 principal === "user" 且恰是"下命令的这一轮"，才派生 `Initiator.user`。** 且这是一次性的：只在处理该条命令的那一轮内有效，之后必须显式重建，防止但管在后续轮次"借用"早期用户命令的 principal。

> **彻底删除旧 §3.1 的"由调用方声明"接口**——它制造"看着能判权"的伪精确，实则给 LLM 留了后门。user / butler / parent 全部由运行时依据可信上下文派生，工具与 LLM 只能消费不能构造。

### 3.2 权威判定（authorize —— 按 seam 注册，不是 if/switch 链）

**锐评 B4**：`authorize` 不能是 per-op 的 if/switch 链（踩 "no scattered type branches" 红线，且每加一个特权工具要改一次）。改为：**每个但管工具注册时自带一条授权策略**，runtime 只负责"注入受信 caller + 调用该工具的策略 + 落审计"，不裁决 per-op 逻辑。

```ts
// 每个特权工具注册时携带自己的授权策略
type ButlerTool = {
  readonly op: string
  /** 若为 true，invokeTool 在 authorize 前必须 target 可解析，否则直接 denied("unknown target")。 */
  readonly targetRequired?: boolean
  readonly authorize: (caller: Initiator, target?: SessionRow) => { allowed: boolean; reason?: string }
  readonly execute: (input: unknown, ctx: ToolCtx) => Promise<unknown>
}
```

策略注册（各工具自述，runtime 只调度）。**通用规则（由 invokeTool 强制，非注释）**：`targetRequired` 为 true 且 `target` 解不出 → 运行时**直接** `{allowed:false, reason:"unknown target"}` 并落审计，**不调用 authorize**（杜绝 `undefined.parentId` 崩溃和"不看 target 误放行"）。

- `list_sessions` → `targetRequired` 缺省 false；`authorize: () => allowed`（观察 always OK）
- `spawn_agent` → `targetRequired` 缺省 false；`authorize: () => allowed`（spawn 者即父，无 target）
- `interrupt` → `targetRequired: true`；`authorize(caller, target)`：
  - `caller.kind === "butler"` → `allowed`（宽权威安全阀，对任意会话）
  - `caller.kind === "parent"` → `target!.parentId === caller.sessionId ? allowed : denied("只能中断自己的直接子会话")`
  - `caller.kind === "user"` → `allowed`
- `send_to_session` → `targetRequired: true`；`authorize(caller, target)`：
  - `caller.kind === "user"` → `allowed`
  - `caller.kind === "parent"` → `target!.parentId === caller.sessionId ? allowed : denied("只能发给自己直接子会话")`
  - `caller.kind === "butler"` → `denied("butler 需用户显式授权")`（**默认拒绝**）

**默认拒绝是防线**：`send_to_session` 逐分支策略里，`butler` 触发一律 `denied`，`parent` 仅对直接子会话放行，其余拒绝。运行时对每个工具调用都执行 `x.authorize(caller, target)`，结果为 `denied` 则**不 execute**、只落审计。
**持续授权**：M2b **只做一次性**（per-prompt principal 绑定到该 prompt 那一轮）。跨 run 的持续授权（持久 grant 表）、显式授予但管 send 的"可持续权限"，**留 M4**——避免无中生有拓宽授权面。

### 3.3 父链完整性（需要新事件 + 限定作用域）

- M2a 的 `Session.Created` **没有 parentId**，`Session.Spawned` 事件不存在——父链当前无法记录。
- **spawn 必须同时落两个事件，保证子会话能被 registry fold 看见**（复评 B1 修正）：
  - `Session.Created { id, location, createdAt }` —— **必须有**，否则 `registry.fold()` 的 `hasCreated` 门槛返回 `undefined`，子会话在 registry 里隐形。
  - `Session.Spawned { parentId }` —— 记录父链。
  - `fold()` 用 `Session.Created` 置 `hasCreated` 并设 id/workspace/createdAt；再用 `Session.Spawned` 填 `parentId`。`Session.Spawned` 不是创建事件，需与 `Session.Created` 成对出现。
  - **spawn 是唯一写 `parentId` 的入口。**
- **作用域须诚实**：单 app registry 只能看自己的 EventStore（M2a 惰性查询）。跨 app/workspace 的父链**必悬空**。本 spec 取：**M2b 限定单进程单 app 内的会话树**，跨 app 跨进程留 M4。`target.parentId` 在 `authorize` 中解析不到时走"target 未知 → rejected"。

### 3.4 受信 caller 注入（ToolCtx）

工具签名从 `execute(input)` 扩为 `execute(input, ctx)`，其中 `ctx.caller: Initiator` 由 loop 注入：
```ts
type ToolCtx = { readonly caller: Initiator }
// loop 在 invokeTool 时构造：caller = { kind: callerKind(session), sessionId: opts.sessionId }
```
- 但管会话：`caller = { kind: "butler", sessionId: butlerSessionId }`
- 普通会话：`caller = { kind: "parent", sessionId: thisSessionId }`（它 spawn 出的孩子会把它记为父）
- `user`：仅当该 prompt 有 user principal 时，该轮 caller 为 `{ kind: "user" }`

### 3.5 审计（落独立 aggregate，非 message 流）

**锐评 A3**：审计不能写进但管自己的 session log（registry 投影只看得到但管那一行，用户查不到细节）。也不能依赖一个不存在的 `Butler.Action` 事件类型。修法：
- 新增 durable 事件 `Session.ButlerAction { sessionId, actorKind, actorId, op, targetSessionId, outcome: "allowed" | "denied", reason, ts }`。
- 写到**独立 audit aggregate**（`aggregate:"audit"` + `audit:<butlerSessionId>`），**不进 message 流、不污染折叠**。
- registry 增 `audit(sessionId?)` 读方法，把 `Session.ButlerAction` 折叠成可查审计列表。
- **允许 + 拒绝都落**，且拒绝理由结构化为 `runtimeRejectReason`（运行时产生，如 "target.parentId !== caller.sessionId"），而非 LLM 自述。
- **actorId 记录执行体**：user 权威下 `Initiator` 无 sessionId，但审计仍需知道"哪个但管会话在执行"——`ButlerAction` 里用 `actorId` 记执行会话 id（执行体），`actorKind` 记权威来源（user/butler/parent）。两者不混淆。

### 3.6 实现前置清单（统一，避免部分遗漏）

实现管家前，必须**一次性**完成以下底层改动（缺一不可，否则权威模型在实现时塌）：

- [ ] `schema/event.ts` 的 `SessionEvent` 联合**新增两个事件**：
  - `Session.Spawned { sessionId, parentId }`
  - `Session.ButlerAction { sessionId, actorKind, actorId, op, targetSessionId, outcome, reason, ts }`
- [ ] `registry.ts fold()` 补 `Session.Spawned` 分支（置 `parentId`，不置 `hasCreated`）——**必须与 `Session.Created` 成对才有会话行**。
- [ ] `registry` 新 `audit(sessionId?)` 读方法：懒查询 `audit:*` aggregateIds + read + fold 成审计列表。
- [ ] `StoreEvent.aggregate` 的 `AggregateType` 扩展为含 `"session" | "audit"`——审计事件用 `aggregate:"audit"` + `aggregate_id:"audit:<butlerSessionId>"`，与 session 折叠隔离。
- [ ] `runner.ts` 工具签名扩为 `execute(input, ctx: ToolCtx)`（`ctx.caller` 由 loop 注入）。
- [ ] `loop.ts` `invokeTool` 增加"注入 caller + 调用工具策略 + 落审计 + denied 不执行"。

---

## 3.x 审计与工具契约示例（确认方向）

```ts
// invokeTool 在 loop 内（受信边界）注入 caller + resolve target + 落审计
async function invokeTool(resolveTool, call, ctx: ToolCtx, registry) {
  const tool = resolveTool(call.name)
  const target = tool.targetRequired && call.input?.target ? await registry.get(call.input.target) : undefined
  // targetRequired 且 target 解不出 -> 强制 denied (unknown target)，不调 authorize
  if (tool.targetRequired && !target) {
    appendAudit({ op: tool.op, actor: ctx.caller, targetId: call.input?.target, outcome: "denied", reason: "unknown target" })
    return { denied: "unknown target" }
  }
  const decision = tool.authorize(ctx.caller, target)
  appendAudit({ op: tool.op, actor: ctx.caller, targetId: call.input?.target, outcome: decision.allowed ? "allowed" : "denied", reason: decision.reason })
  if (!decision.allowed) return { denied: decision.reason ?? "unknown target" }
  return tool.execute(call.input, ctx)
}
```

关键：`caller`（受信注入）与 `call.input`（LLM 可控）严格分离——`authorize` 只看 `ctx.caller`，`execute` 才读 `call.input`。`target` 由 runtime 经 registry 解析，LLM 无法伪造目标身份。

---

## 4. 边界与不做

- **不做**：跨进程 daemon（M4）、磁盘 mailbox/lease（M4）、内容审查（运行时不裁决内容对错）。
- **单进程单 app**：管家与子会话同进程、同 app（限定在单一 EventStore / registry 能见的作用域），跨 app 跨进程留 M4。
- **不为管家加读心**：管家是 LLM，它的上下文即它可见的 registry + 它 spawn 的子会话结果。不额外给它"全知"。
- **可审计性是必须项，不是可选项**：管家每次主动操作（含被拒的）都落审计事件，用户可查"管家做了什么、为什么被拒"。

---

## 5. 权威模型的三个测试场景（实现后必测）

1. **butler 无授权 send 被拒**：管家对非子会话 send → `denied`，审计记录"被拒"。
2. **parent 只能对自己的子会话 send**：父会话 spawn 出 A，父可 send 到 A；父 send 到非子 B → `denied`。
3. **user 最高**：用户命令"管家把 X 发给 Y" → butler 以 `Initiator.user` 执行 → allowed。

---

## 6. 独立锐评要求

实现前，本 spec 先经独立 subagent 锐评，重点审：
- **A1（必须结构性成立）**：`Initiator` 是否**由运行时注入**而非自报——即"任何会话能否伪造 `{kind:"user"}` 拿到最高权威"是否有**确定性答案为否**。
- **A2（必须结构性成立）**：user 权威是否**只走 transport principal**，绝不由 LLM 从 prompt 文本推断——"但管读用户消息自认授权"是否被彻底杜绝。
- **A3（必须结构性成立）**：审计事件是否**落到独立 audit aggregate**，用户能在 registry/audit 读到允许+拒绝，而非埋在 message 流。
- 权威判定是否**默认拒绝、显式授权**（防滥用核心）。
- 授权是否**按 seam 注册**（每个工具自带策略），而非 per-op if/switch 链（红线）。
- send 窄权威 vs interrupt 宽权威（含归属约束）的对照是否成立。
- 父链是否限定单进程单 app 作用域、无悬空。

**必须"锐评通过、findings 清零"后才允许实现管家 LLM 大脑。**

---

## 7. 复评要求（实现后）

实现管家后，同锐评方须**复评**：确认 A1/A2/A3 在代码里是结构性保证（非注释/文案），并用真实路径验证：
- 但管无授权 send 被拒，且落审计（含拒绝）。
- parent 只能对直接子会话 send。
- user principal 只在"该 prompt 的那一轮"有效，后续轮次不能借用。
- 审计在 registry/audit 可查（含拒绝）。

**复评通过 = 实现 done；复评发现 findings 必须清零。**


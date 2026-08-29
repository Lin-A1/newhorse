# Agent Roles & Capabilities (Phase 4) 设计 Spec

> 状态：**规划（2026-08-30）** — 目标：给 subagent 明确的**身份（专业方向）+ 能力（工具白名单）+ 模型**，让 DAG 节点和但丁 spawn 都能点名"我要哪个 agent"。
> 借鉴（标注出处，不自称原创）：OpenAI Codex `agent_type` role overlay（`codex-rs/core/src/agent/role.rs` — 子代理配置只能**减少**父的权限，不能越权）；Claude Code plugin `agents/*.md` frontmatter（`allowed-tools` 声明式工具白名单 + `model`）。

---

## 0. 现状缺口（代码事实）

- `AgentCapability`（plugin/registry.ts:23）只有 `name/description/model`——**无 role、无 allowed-tools、无正文（专业指令）**。
- `readAgent`（plugin/discovery.ts:129）只解析 frontmatter，**丢弃 markdown 正文**——agent 的专业方向/指令全丢。
- `AgentSpec`（core/agent/dag.ts:16）有 `name/model/tools?/role/preset`——但 **tools 未被消费层接线**。
- **零消费者**：`registry.list("agent")` 无人调用（docs §17 注明）。

---

## 1. 设计

### 1.1 Agent 定义（身份 + 能力 + 专业方向）

```ts
// plugin/registry.ts — 扩展 AgentCapability
export interface AgentCapability {
  kind: "agent"
  name: string
  description: string                  // 专业方向（模型可见，用于选人）
  /** 系统指令/专业方向正文（SKILL.md 式 body）。注入子会话的 system 上下文。 */
  readonly body?: string
  /** 工具白名单：该 agent 可用的工具名（缺省 = 全部）。限制性白名单，不是加集。 */
  readonly allowedTools?: readonly string[]
  /** 身份角色键：被 costDown / 调度引用（"researcher"/"reviewer"…） */
  readonly role?: string
  /** 默认模型（costDown 未指定时该 agent 用它） */
  model?: string
}
```

- **目录即注册面**（已有）：`agents/<name>.md` frontmatter 声明 `description/model/allowed-tools/role` + 正文即 body。
- **`readAgent` 保留正文**——body 是子会话的专业指令来源。

### 1.2 Role overlay（codex 模式——限制性叠加）

**子代理的最终能力 = 父能力 ∩ agent 定义白名单**——一个 agent 永远不会得到父没有的工具（越权防护）：

```
resolveAgentTools(builtin[] | agent.allowedTools)
  -> allowedTools 缺省    : call 用全部（无限制）
  -> allowedTools 给定时  : 只保留白名单内的（子代理 < 父，限制性）
```

- **模型**：`agent.model` 显式 > costDown 规则 > 父模型（与 DAG resolveNodeModel 同序）。
- **正文**：确定后注入子会话 system 上下文（`agent.body` + 父的 workspace context 并存）。

### 1.3 消费层（补上"注册了没人用"）

- **DAG**：`node.agent.name` 可引用插件 agent——`runDag` 接受一个 `agents?` 注册表（`PluginRegistry` 或 `Record<name, AgentCapability>`）；节点解析：`agent = registry.get("agent", node.agent.name)`。`AgentSpec.tools` 由 `allowedTools` 确定。
- **Butler spawn**：`spawn_agent` 工具支持 `agent: "name"` 参数 → 解析 agent 定义（身份/能力/模型 + 正文）。
- **缺省**：无 agent 名 = 裸 agent（父全部工具，无专用正文）——向后兼容。

### 1.4 可插拔边界

- Agent 定义从 `PluginRegistry` 拉（注册面已存在）；`resolveAgent` 是运行时纯函数（输入 capability + 父工具集 → 输出 agent 配置）。**不做散落 if/switch**：agent 是 seam 的一个 kind，消费经 seam。

---

## 2. 接口变化

| 文件 | 变化 |
|---|---|
| `packages/plugin/src/registry.ts` | AgentCapability + `allowedTools/role/body` |
| `packages/plugin/src/discovery.ts` | readAgent 保留正文 + 解析新 frontmatter 字段 |
| `packages/runtime/src/dag-runner.ts` | `DagDeps.agents?`（注册表）；runNode 用 resolveAgent |
| `packages/runtime/src/app.ts` | fromPluginRegistry 传给 DAG/butler；spawn_agent 支持 `agent:` |
| `packages/runtime/src/butler.ts` | spawn_agent input 加 `agent` 参数 |
| `packages/runtime/src/agent-resolver.ts` (新) | `resolveAgent(config, parentTools)` 纯函数 |

---

## 3. 验收

- [ ] `agents/<name>.md` 发现：frontmatter(name/description/model/allowed-tools/role) + body 完整
- [ ] `resolveAgent`：allowedTools 限制性叠加（子代理 ≤ 父）；无白名单 → 全部；model 优先级正确
- [ ] DAG `node.agent.name` 引用 agent 定义（含 tools + body 注入 + model）
- [ ] `spawn_agent` 支持 `agent:` 参数
- [ ] 无 agent 名 = 向后兼容（裸 agent）
- [ ] 测试 + 全包回归 + 独立复审

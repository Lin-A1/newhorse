# Todo (model-maintained task list) 设计 Spec

> 状态：**已实现（2026-08-30）** — 事件 + 折叠/校验 + 工具 + createApp/DAG/CLI 接线全部落地（尾部 user-role 投影为可选增强，诚实延后）。 — 目标：给模型一个**持久的、事件溯源的**任务清单工具（todo/plan 模式），让长任务自我组织。
> 借鉴（标注出处）：**opencode** `todowrite`（全量替换 + 事件溯源 `todo.updated` + subagent 默认 deny——与本引擎 log-first 原则最契合）；**claude code** `activeForm`（spinner UX）+ `<system-reminder>` 注入与"仅一个 in_progress"规则；**codex** `update_plan`（全量替换 + 至多一个 in_progress；其**非持久**设计被明确拒绝——违反 log-first）。

---

## 0. 设计决策（调研结论）

- **一个事件**：`Session.TodoUpdated { todos: TodoItem[] }`——全量快照（"当前清单"= 最后一条该事件），投影/重放平凡。不做逐项 patch 事件（三个项目全用全量写，逐项事件徒增重放复杂度）。
- **Item 形状**：`{ content: string, status: "pending"|"in_progress"|"completed"|"cancelled", activeForm?: string }`——`cancelled` 取自 opencode（保留被弃工作的历史），`activeForm` 取自 claude code（spinner UX，可选回退 content）；**skip** opencode 的 `priority`（无工具使用它）。
- **工具**：单个 `todo_write`，**全量替换**输入 `{ todos: [...] }`（三者通用：自愈、无合并歧义）；**结果回显规范化的清单**（opencode 的 toModelOutput 模式——codex 的 "Plan updated" 省 token 但逼模型从历史追状态）。
- **执行规则**（handler 软校验，违规作为模型可读的 tool error）：至多一个 `in_progress`；空清单合法（列表的结束方式）；content 上限长度。
- **subagent 默认 deny**（opencode 模式）：子代理不改父的清单——但 newhorse 的子会话是独立 aggregate，天然隔离（各自 fold 各自的 TodoUpdated），无需权限位。
- **上下文重入**（不破坏 Anthropic 缓存锚点）：绝不进 system 前缀。基线 = 工具结果回显（清单天然在历史里）；增强 = claude-code 式 user-role 尾部投影（清单变化或 N 轮未更新且有剩余工作时，把当前清单作为 `compaction` 式 user 消息追加到尾部——**扩展**缓存前缀而非改写）。投影是派生态，不写新事件。

---

## 1. 接口变化

| 文件 | 变化 |
|---|---|
| `packages/schema/src/event.ts` | `Session.TodoUpdated { todos }` |
| `packages/core/src/agent/todo.ts` (新) | `TodoItem` 类型 + `currentTodos(stored)` 折叠（最后一条 TodoUpdated）+ 投影 helper |
| `packages/runtime/src/tools/todo.ts` (新) | `todo_write` 工具（全量替换 + 校验 + 回显） |
| `packages/runtime/src/tools/index.ts` | builtin 注入 `todo_write`（默认可用——清单是会话自我组织的基本能力） |
| `packages/core/src/agent/loop.ts` | 尾部投影（可选，ListChanged/N 轮陈旧时 append user 消息） |

## 2. 验收

- [ ] `todo_write` 全量替换 + 回显；>1 in_progress 拒绝（模型可读 error）；空清单合法
- [ ] 事件溯源：重启后 `currentTodos` 从 log 重建（last TodoUpdated）
- [ ] 子会话天然隔离（各自 aggregate）
- [ ] 测试 + 独立复审 + 提交推送

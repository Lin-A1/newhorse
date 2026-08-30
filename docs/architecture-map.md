# Architecture Map — 全机制锚点（防漂移）

> 状态：**巩固锚点（2026-08-30）**。目的：列出全部已实现机制、它们服务的 AGENTS.md 支柱、相互衔接关系，以及跨机制不变量——实现新东西前对照本图，防止**目的漂移**（做不在北星里的功能）与**功能漂移**（机制间语义脱节/重复）。
> 规则：本图与代码冲突时，以代码为准并立即修图。每个机制标注 [支柱#]。

## 仓库拓扑（命名区分）

```
newhorse（本 monorepo：引擎开发地 + 首个宿主项目 CLI）
  ──runtime 改造在此开发，落地后同步──▶  agent-runtime（github.com/Lin-A1/agent-runtime：独立存储 / 复用边界）
```

- 本图描述的机制**同时存在于两仓**（agent-runtime 是本仓的独立镜像/复用边界）。runtime 包（schema/core/llm/plugin/memory/runtime/server/sdk）的改动在 newhorse 落地后必须同步到 agent-runtime。
- 命名：文档中 "the engine" 指 runtime 包集合；"newhorse" = 引擎 + 首个宿主（CLI/host flows）；"agent-runtime" = 独立复用仓库。
- 非运行时工作（宿主流程、项目特定工具）只留在 newhorse，不同步。

---

## 0. 五支柱 → 机制映射（目的锚）

| 支柱 | 服务它的机制 |
|---|---|
| **1. 声明式 DAG + 模型调度** | `core/agent/dag.ts` + `runtime/dag-runner.ts`（resumeDag/cost-down/role overlay/DAG↔todo 投影）、`session-manager.ts`（driveChildSession） |
| **2. 长时运行** | `core/session/*`（SQLite 原子 seq）、`agent/compaction.ts`（本地折叠+LLM 摘要 seam）、`agent/goal.ts`（预算=usage 聚合）、`agent/todo.ts`（重启安全清单） |
| **3. 成本控制** | `dag-runner.resolveNodeModel`（cost-down）、`agent-resolver`（agent.model）、`Session.StepEnded.usage` 持久化 + `goal.ts` tokensUsed 聚合 |
| **4. 模型无关** | `llm/*`（四轴 Route + 3 协议 + 重试）、`schema/llm.ts`（单一词汇）、`memory/embedding.ts`（EmbeddingProvider seam——模型形状差异隔离） |
| **5. 可用 + 可扩展** | `plugin/*`（五类 seam + 目录发现）、`tools/*`（12 工具）、`server`（HTTP/SSE）、`cli`（REPL+dag）、`runtime/context.ts`（可插拔上下文）、hook seam（stop/pre-tool-use）、`skill` 工具 |

**漂移检验法**：新机制必须能回答"我服务哪条支柱"；答不出 = 目的漂移，砍或重新定位。

## 1. 机制清单（状态 @ 818970e8a+）

| 机制 | 文件 | 状态 | 衔接（依赖 → 被依赖） |
|---|---|---|---|
| 事件溯源存储 | `core/session/{store,sqlite}.ts` | ✅ 生产 | ← 一切持久机制 |
| Admission inbox | `core/session/input.ts` | ✅ 生产 | ← loop 提升 steers/queue；hub.send |
| Turn loop | `core/agent/loop.ts` | ✅ 生产 | ← app/server/dag；→ hooks/todos/compaction 触发 |
| Compaction（本地+LLM seam） | `core/agent/compaction.ts` + loop 触发 | ✅（LLM 摘要 seam 已接线未注入真实摘要器——诚实清单） | 依赖 usage 持久化 |
| Hook seam | `loop.ts runHooks` + `app.makeHookRunner` | ✅（stop/pre-tool-use 两事件，白名单收窄） | ← plugin registry hooks |
| LLM 四轴 Route | `llm/*` | ✅ 生产（anthropic 真机；openai 真机 S6；responses mock 级） | ← 一切模型调用 |
| 插件五类 seam | `plugin/*` | ✅ | → tools(消费)/agents(roles)/skills(loader)/commands(runCommand)/hooks(runner) |
| Agent roles | `runtime/agent-resolver.ts` | ✅ | ← plugin agents 定义；→ DAG 节点/spawn_agent |
| 内置工具 ×12 | `runtime/tools/*` | ✅（真机 S7 实证） | read/write/edit/list/search/bash/memory×2/skill/todo/goal×2 |
| execpolicy | `runtime/tools/execpolicy.ts` | ✅（14 轮审查 + bootstrap 接线） | ← bash/write/edit/read 决策；approve 持久规则 |
| Memory（store+FTS5+语义） | `memory/*` | ✅（语义真机：1536 维零重叠命中；model tag 防混） | 提取管线 `extract.ts` 引擎就绪、**触发已接**（memoryExtract.enabled） |
| Runtime server | `server/*` | ✅（Bun 1.3.14 断连 panic=已知 skip，升级后重开） | ← createApp；→ 未来 SDK/TUI |
| CLI | `cli/src/index.ts` | ✅（REPL + dag 子命令 + slash + /list） | ← createApp/runDag |
| SessionManager（M4 进程内） | `hub.ts register/interrupt/send` | ✅（进程内真投递；跨进程=真 M4 边界） | ← app.prompt 登记 + child registerLive |
| DAG（声明式） | `core/agent/dag.ts` + `runtime/dag-runner.ts` | ✅（resume/slots 持久/cost-down） | → Session.Settled（统一 task）→ todo 投影 |
| 统一 task（goal×DAG×todo×task） | `core/agent/{todo,goal}.ts` | ✅（DAG catch 路径 settlement 已锁） | goal 预算=usage 聚合；强制（自动暂停）未做 |
| 真子会话驱动 | `runtime/session-manager.ts`（driveChildSession/readChildText） | ✅ | ← DAG 节点/hub spawn；Created→上下文→admit→runSession 统一路径 |
| 编排工具（动态面） | `runtime/butler.ts`（spawn/followup/wait/send/interrupt/list） | ✅（send/interrupt 经 hub 真投递；子会话经 registerLive 可中断） | ← SessionManager + registry；模型编排的主入口 |
| 可插拔上下文 | `runtime/context.ts`（contextProvider + ensureSystemContext） | ✅（并发安全 in-flight 去重） | ← app.prompt（主会话）+ DAG 节点/hub（子会话继承） |
| 记忆提取管线 | `memory/extract.ts` + `runtime/memory-pipeline.ts` | ✅ 引擎+触发已接（memoryExtract.enabled） | LLM pipe（默认模板）+ store |

## 2. 跨机制不变量（功能间不漂移的锚）

1. **model-visible ⟺ logged**：模型可见的一切先入 log（system context/todos/工具结果/compaction 标记）。新机制违反此条 = 设计错。
2. **append-only**：compaction/todo/goal/memory 全是追加语义——改写历史=设计错（memory 的 update/merge = 新行 + 删除旧行，provenance 留存于事件）。
3. **fail-closed 权限**：无 execpolicy → deny-all；无 approve 闸 → prompt=forbid；目录钩子 exit≠0=block。
4. **fail-soft 外围**：hooks/memory-embed/提取管线/事件监听器失败**降级不崩**（与 3 的权限面相反——权限面硬、能力面软）。
5. **seam-only**：能力经 seam 注册（plugin 五类/Provider 接口/工具工厂），消费点不 if/switch 具体类型。
6. **可插拔降级**：FTS↔向量、LLM 摘要↔本地标记、send 真投递↔诚实 implemented:false——每能力都有"降一级仍可用"的档位。
7. **一个词汇**：一切模型交互走 `LLMRequest/LLMEvent`；一切持久走 `(aggregate_id, seq, type, data)`。
8. **transport 零领域逻辑**：CLI/server 只 parse+render；domain 只在 core/runtime。

## 3. 已知边界（诚实清单，非缺陷）

- hub `interrupt/send` 仅进程内（跨进程 SessionManager = 真 M4）
- Bun 1.3.14 断连 panic（server skip 测试；`bun upgrade` 需手动 PowerShell）
- goal 预算强制（自动暂停）未做——`overBudget` 仅可见性
- compaction LLM 摘要 seam 接线未注入真实摘要器（`compactSummarize` 待 app 传）
- `.ts` 插件加载（信任边界未定）、`Session.ToolSettled` 死类型
- openai-responses 协议 mock 级（未真机）
- todo 尾部投影（claude-code 式 reminder）延后（工具回显为基线）

## 4. 漂移哨兵（实现新东西前自问）

1. 服务哪条支柱？（§0 表）
2. 与哪个既有机制衔接、复用哪个 seam？（§1 表——不新造平行机制）
3. 违反 §2 哪条不变量？（答"违反"= 停）
4. 降级档位是什么？（§2.6）
5. 事件与词汇走 §2.7 的形状吗？

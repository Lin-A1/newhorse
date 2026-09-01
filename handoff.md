# Handoff — 前端从零重写（给下一个模型）

> 2026-09-01。引擎（`packages/*`）**完成且稳定**，上一轮做的前端（web + desktop）已**整体删除**——用户拍板换人重写。本文件是唯一交接物：读完即可开工，不需要问历史。
> 旧前端代码在 git 历史里可查但**不要照抄**：`ff81b663f`（最后一版，含情绪球移植）与更早的 `5e9204856`。用户对它的评价是“打回重做”。

## 0. 任务

为 newhorse 引擎重写客户端。先 web（`apps/web`，Vite + React + Tailwind 即可），desktop 之后再说。**一切视觉从参考源码抄，不要自创**。

## 1. 用户审美决策（多轮反馈钉死的，违反任何一条都会被打回）

1. **工程化、简约**。对齐 ZCode / codex / opencode 的产品气质：中性灰表面、白色透明度边框、紧圆角、14px 基准、mono 字体承载元信息、无渐变无辉光。
2. **禁止 emoji**。情绪球是唯一“脸”，只出现在封面主视觉、侧栏品牌位、会话头像——不做装饰散布。
3. **禁止自造颜色**。天蓝、紫罗兰、“蜜桃”全被否过，紫色粒子也被打回。配色只从参考源码提取（见 §3）。
4. **不造人设名**。「管家」「头马」都被否；常驻会话就叫 **newhorse**。引擎键 `role: "butler"` / `asButler` 是持久化标识符，不改，但 UI 文案一律 newhorse。
5. **封面球要高表现力**：会眨眼、眼神跟随鼠标、不同状态不同表情（见 §4）。
6. **工作区与常驻会话必须是一等概念**：侧栏顶部工作区身份块；每个工作区一个**常驻 newhorse 会话**置顶（引擎按工作区派生稳定 id，见 §5.2）；封面 composer 直接把任务发进常驻会话。

## 2. 仓库与工作方式

- Bun + TypeScript monorepo。引擎包：`packages/{schema,core,llm,plugin,memory,runtime,server,sdk,cli}`——**这些不要动**（除非发现 bug，单独提）。
- 分支 `dev`；commit 用 conventional style（`feat(web): …`）；分支名 ≤3 个单词连字符（`session-recovery` 风格）。
- 测试/类型检查在**包目录里**跑：`bun typecheck`、`bun test`（不要从仓库根跑 tsc）。
- 冒烟脚本在 `scripts/smoke/`（`client-surfaces.ts` 无密钥可跑 9/9），假 LLM 在 `scripts/fake-llm.ts`。
- 镜像同步：只同步 `packages/*`，纯前端改动**不需要**跑 `scripts/sync-agent-runtime.ts`。
- 文档基线：`AGENTS.md`（引擎北极星）、`docs/product-voice.md`（审美决策记录）、`docs/architecture-map.md`（机制地图）。

## 3. 参考源码（先读再动手；G:/temp 是临时目录，可能已清，附重建命令）

| 来源 | 本地路径 | 用途 |
|---|---|---|
| **ZCode 安装包（首选基准）** | `D:\ZCode`（Electron 应用）。解包：`npx @electron/asar extract D:\ZCode\resources\app.asar G:/temp/zcode-src`，样式表在 `out/renderer/assets/styles-*.css` | 设计 token。已提取的关键值：暗背景 `#161616`、面板 `#202020`、侧栏 neutral-950 方向、边框=白 8%/强 16%、`--color-brand` 浅色=`#000` / 深色=sky-500 `#0ea5e9`、圆角 4/6/8/10px、`--ui-font-size:14px`、trajectory 五色（user `#60a5fa` / assistant `#2dd4bf` / reasoning `#a78bfa` / tool `#f59e0b` / tool-result `#38bdf8`） |
| **opencode** | `G:/temp/opencode`（github.com/sst/opencode，可重克隆） | 主题 `packages/ui/src/theme/themes/oc-2.json`：文本四梯 `#EDEDED/#A0A0A0/#707070/#505050`、error `#fc533a`、diffAdd/Delete；IA 参考：侧栏状态点（工作中琥珀脉动/错误红）、todo dock 在 composer 上方、Context 页统计网格 |
| **codex** | `G:/temp/codex`（github.com/openai/codex，可重克隆） | 克制气质参考（TUI 单色 + 极少 accent） |
| **beautifului** | `G:/temp/beautifului-src`（github.com/TurboKach/ai-native-react-components，可重克隆） | 组件源码可整段抄（prompt-bar / tool-chips / approval-card / task-rows / records-table 等 19 件 + atoms），CSS 变量体系在 `app/globals.css`。注意它假设 Tailwind v4 + `glimm`/`liveline` npm 包；用 Tailwind 3.4 时需转换映射 |
| **emotion-ball** | `G:/temp/aora-bot/emotion-ball`（github.com/sam70361/aora-bot，可重克隆） | 球的全部源码（见 §4） |

已验证可用的深浅两套 token 之前写在旧 `apps/web/src/index.css`：`git show ff81b663f:apps/web/src/index.css` 可直接取回——**这是历史里少数值得直接复用的部分**。

## 4. 情绪球（封面的表现力担当）

- 来源 `github.com/sam70361/aora-bot` 仓库 `emotion-ball/` 目录：`rings.js`（25 组眼环几何数据 + blob 身形）、`emotions.js`（40 套表情配置，id 即对外契约：00-09 生命周期 / 10-29 情绪 / 30-49 代理状态）、`ball.js`（SVG 渲染：球面投影眼睛、3D 彩带轨道、撒花、zzz）、`engine.js`（rAF 状态机、弹簧插值、眨眼、待机小动作、gaze）、`hero-particles.js`（首屏星尘+半调点阵 canvas）。
- **许可**：引擎代码与表情数据=社区许可（非商业免费，商业需另行授权）；blob 视觉形象限个人学习研究。vendored 文件头保留来源+许可标注；粒子配色要把上游紫色改为中性白/灰（上一轮已改过，见 `ff81b663f` 的 `particles.ts`）。
- 引擎用法：`EmotionBall.create(el, { emotion, lite, idle })` → `setEmotion(id)` / `setGaze(nx,ny)` / `spin(n)` / `burst()`；`lite:true` 出静态头像（无 rAF）。
- 上一轮验证过的状态映射（建议沿用）：boot=`05`、idle=`02`、listening=`35`、thinking=`30`（常驻环带）、searching=`40`、replying=`39`、done=`33`（彩带+撒花）、error=`34`（闪红）、sleep=`00`（zzz）。
- React 包装参考 `git show ff81b663f:apps/web/src/components/EmotionBall.tsx`。

## 5. 引擎接口面（对照 packages/server/src/server.ts 核实过，全部可用）

### 5.1 HTTP（默认 `http://127.0.0.1:3927`，Bearer token 鉴权）

```
GET  /v1/health
POST /v1/session                          # body {sessionId?, workspace?, asButler?}
GET  /v1/sessions[?workspace=]            # 行结构见 §5.3
GET  /v1/session/:id                      # snapshot {id, messages?, headSeq}
GET  /v1/session/:id/events               # StoredEventRow[]（转录从这折）
POST /v1/session/:id/prompt               # body {text, images?:[{mime,data}]} → SSE（见下）
POST /v1/session/:id/steer {text}         # 回合中追加（durable）
POST /v1/session/:id/interrupt
GET/POST /v1/session/:id/policy           # policy: strict|readonly|trusted
POST /v1/session/:id/fork {atSeq?}        # atSeq=用户事件 seq，回退重发
DELETE /v1/session/:id                    # 物理删除（用户发起）
POST /v1/session/:id/archive {archived}   # true=归档 / false=恢复
POST /v1/session/:id/title {title}
GET  /v1/session/:id/goal ; POST 同形 {objective, tokenBudget?}
GET  /v1/session/:id/todos                # [{content,status}]
GET  /v1/session/:id/context              # {chars, estTokens, windowTokens?, ratio?}
POST /v1/session/:id/command {text}       # 斜杠命令（/name args），GET /v1/commands 列目录
GET  /v1/settings ; PUT /v1/settings      # AgentHomeConfig 深合并；可清字段见 runtime/config.ts
GET  /v1/models                           # 当前供应商可用模型
GET  /v1/approvals ; POST /v1/approvals/:id {allow}   # 待审批（轮询）
GET  /v1/usage?days=N                     # {days[], totals, sessions, sessionRows[]}
GET/POST /v1/schedules ; PATCH/DELETE /v1/schedules/:id ; POST /v1/schedules/:id/run
GET  /v1/memory?q= ; POST /v1/memory {content,type?,priority?} ; DELETE /v1/memory/:id
GET  /v1/fs?workspace=&path=              # 沙盒单层目录列举
GET  /v1/skills[?name=] ; GET /v1/agents
POST /v1/dag {spec} ; GET /v1/dags ; GET /v1/dag/:id
GET  /v1/live                             # 跨进程目录视图
```

**prompt SSE**：先发注释行 `: open`（Bun 首字节才刷头，客户端必须立即能读到 200）；事件 = LoopEvent 原样转发：`{type:"text"|"reasoning", text}`、`{type:"tool", name, input}`、`{type:"tool-result", output, isError?}`、`{type:"step", step}`、`{type:"error", code, message}`、`{type:"done", finish}`；然后 `{type:"result", ...}` + `data: [DONE]`；每 15s 一条 keepalive 注释；客户端断开会触发 interrupt。

**settings 可写字段**（PUT 合并语义，secrets 回显已脱敏）：`model`、`contextWindowTokens`、`maxOutputTokens`（单次回复预算，缺失时 anthropic 协议静默截 4096）、`activeProviderId`（切供应商预设 = ccswitch 语义，原子生效）、`provider`、`memory.*`、`allowBash`、`allowPluginCode`、`token`、`host`、`port` 等。预设列表在 `providers[]`（`{id,name,kind,baseUrl,model,hasApiKey,apiKeyHint}`）。

### 5.2 常驻会话机制（重要）

`POST /v1/session` **不带 sessionId** 时，引擎用 `stableSessionId(workspace)` 派生确定性 id——同一 workspace 永远返回同一会话。所以“常驻 newhorse 会话”不需要客户端记忆 id：每次都 `createSession(undefined, ws)` 即幂等。列表里它带 `role: "butler"`。

### 5.3 事件日志语义（客户端从 events 折转录，别造旁路）

行结构 `StoredEventRow = {aggregate?, seq, type, data, ts?}`；
`SessionRow = {sessionId, workspace, title?, status: "created"|"active"|"settled"|"interrupted", model?, parentId?, role?: "butler", createdAt, updatedAt, archived?, tokensUsed?}`。

折叠规则（上轮 `foldTranscript` 验证过的语义，实现可抄 `git show ff81b663f:apps/web/src/api.ts`）：
- `Session.Prompted` → 用户轮；`data.images` 仅最后一条用户消息渲染（老化规则）；**seq 就是 fork 点**。
- `Session.MessageAppended`：message.kind=assistant → 按 content 数组展开 text / thinking / tool-call；kind=tool 的结果消息按调用顺序回填到对应 tool-call 行；`output` 含 `"error":` 标错误行。
- `Session.TodoUpdated` → todo dock（放 composer 上方，不进转录）；`Session.GoalUpdated` / `Session.MemoryStored` / `Session.Interrupted` / `Session.Compacted` → 弱化 note 行。
- 文件改动卡：折叠 assistant 的 write/edit tool-call（write=全文 add；edit=old/new 行级 trim 前后缀得 hunk）。

### 5.4 运行与隔离

```
AGENT_RUNTIME_HOME=G:/temp/nh-dev-home NEWHORSE_PORT=3931 NEWHORSE_UI_DIR=<dist> bun packages/server/src/main.ts
```

- **AGENT_RUNTIME_HOME 是隔离测试的键**（默认 `~/.newhorse` 是用户真实数据，测试必须显式指到临时目录）。
- 服务器直接服务 dist（单源=web/手机同一产物）；无 UI 目录时纯 API。
- 全部 env 键在 `packages/runtime/src/config.ts` 的 `ENV` 表（NEWHORSE_PORT / NEWHORSE_TOKEN / NEWHORSE_MODEL / …），默认端口 3927。

## 6. 上一轮踩过的坑（别再踩）

1. **Tailwind 指令漏写**：自定义 index.css 必须带 `@tailwind base/components/utilities`，否则工具类全不生效（页面“裸奔”）。
2. Bun SSE：响应头直到首个 body 字节才发出——服务器已用 `: open` 注释解决；客户端别再加首包超时判断。
3. Windows GBK 终端下 curl 发中文 JSON 会乱码——测接口用 python urllib。
4. 图片：`{mime, data(base64 无前缀)}`，上限 4MB/张、5 张/条；只随最后一条用户消息降低。
5. 删目录前先清 vite/esbuild 常驻进程（Windows 上会锁 apps 目录）。
6. 球的 vendored 文件用 `// @ts-nocheck` 整段收编即可，别逐行改写成 TS（改写必出 bug）。
7. 轮询节奏：会话列表 4s 一轮够用；回合中 1.5s；流式渲染直接吃 prompt SSE，不要靠轮询做流式。
8. 前端依赖从零装：react / react-dom / react-router-dom / lucide-react + vite/@vitejs/plugin-react/tailwindcss 3.4/autoprefixer/postcss/@types/*。

## 7. 验收标准（Definition of Done）

1. 深浅两主题都成立，色值全部来自 §3 提取表，页面上找不到第四种自造色。
2. 封面：球（注视鼠标/多表情）+ composer + 建议任务 + 最近会话；发送直达常驻会话。
3. 会话页：折叠转录（trajectory 角色色竖标）、todo dock、审批卡、steer、回退 fork、策略切换、图片附加。
4. 侧栏：工作区身份块 + 常驻会话置顶 + 按工作区分组 + 归档组 + 状态点。
5. 设置 / 用量 / 记忆 / 定时四页可用（数据全来自 §5.1 接口）。
6. `bun typecheck`、`bun run build` 过；无密钥冒烟（fake-llm 或 client-surfaces）过；浏览器逐页截图自验。
7. 提交推送 dev；纯前端改动不用同步镜像。

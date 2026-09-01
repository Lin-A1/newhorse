# Handoff — 前端从零重写（给下一个模型）

> 2026-09-01。引擎（`packages/*`）**完成且稳定**，上一轮做的前端（web + desktop）已**整体删除**——用户拍板换人重写。本文件是唯一交接物：读完即可开工，不需要问历史。
> 旧前端代码在 git 历史里可查但**不要照抄**：`ff81b663f`（最后一版，含情绪球移植）与更早的 `5e9204856`。用户对它的评价是“打回重做”。

## 0. 任务

为 newhorse 引擎重写客户端。**web 先行（`apps/web`，Vite + React + Tailwind 即可），desktop 是同一交付目标的一部分，不是可选项**：最终要打包成桌面应用（Tauri 2 壳 + 编译后的 server sidecar + 内置 web dist）。上一版已按此发过 v0.1.0 NSIS 安装包，整个 Tauri 配置可从 git 历史整体取回参考：`git show ff81b663f -- apps/desktop`（含 `src-tauri/`、sidecar、capabilities、icons）。

视觉原则：**参考源码里有的照抄；没有的组件/场景按已提取的 token 与风格语言仿造**（同族灰阶、透明度边框、紧圆角、既有 accent），不引入新的色相和花哨效果。

## 1. 用户审美决策（多轮反馈钉死的，违反任何一条都会被打回）

1. **工程化、简约**。对齐 ZCode / codex / opencode 的产品气质：中性灰表面、白色透明度边框、紧圆角、14px 基准、mono 字体承载元信息、无渐变无辉光。
2. **禁止 emoji**。情绪球是唯一“脸”，只出现在封面主视觉、侧栏品牌位、会话头像——不做装饰散布。
3. **禁止自造色相**。天蓝、紫罗兰、“蜜桃”全被否过，紫色粒子也被打回。基色从参考源码提取（见 §3）；参考里没有的组件用同族灰阶/透明度/既有 accent 仿造，不引入新色相。
4. **不造人设名**。「管家」「头马」都被否；常驻会话就叫 **newhorse**。引擎键 `role: "butler"` / `asButler` 是持久化标识符，不改，但 UI 文案一律 newhorse。
5. **封面球要高表现力**：会眨眼、眼神跟随鼠标、不同状态不同表情（见 §4）。
6. **工作区与常驻会话必须是一等概念**：侧栏顶部工作区身份块；每个工作区一个**常驻 newhorse 会话**置顶（引擎按工作区派生稳定 id，见 §5.2）；封面 composer 直接把任务发进常驻会话。
7. **功能上也要补全，对齐 ZCode**——视觉和功能是同一档要求，不把“简约”当砍功能的借口。逐项清单见 §1.5。

## 1.5 功能补全清单（对齐 ZCode，逐项验收）

ZCode（D 盘安装包）的产品功能面，逐项映射到我们引擎已有的接口。**每一项都要有 UI 落点**；做完一项勾一项，验收时对着清单过。
来源：对 ZCode 解包产物（`G:/temp/zcode-src`，重建命令见 §3）renderer 全量 JS 做 CJK 字符串抽取（828 条，副本在 `G:/temp/zcode-strings.txt`，临时目录可能被清）逐条归类后的结果——清单外如再发现新功能，先查引擎有无端点再决定进清单还是进暂缓。

| # | ZCode 功能 | 引擎落点 | UI 要求 |
|---|---|---|---|
| 1 | 会话管理（列表/搜索/重命名/归档/删除/分叉） | §5.1 sessions 相关端点 | 侧栏分组 + 归档组 + 双步删除 + 回退 fork |
| 2 | 流式对话（正文/推理/工具卡片折叠、错误态） | prompt SSE + events | 流式渲染、thinking 可折叠、tool 行可展开输出 |
| 3 | 中断 / 追加（steer）/ 排队 | interrupt / steer | 会话页头部中断按钮；进行中输入自动转追加 |
| 4 | 权限分级 + 审批 | policy + approvals | 会话级三档切换；审批托盘（允许/拒绝） |
| 5 | 任务清单 + 目标预算 | todos / goal | composer 上方 todo dock；goal 预算展示 |
| 6 | 上下文用量统计 | /v1/session/:id/context | 上下文占比指示（ZCode 的 context 页思路） |
| 7 | 文件改动 review（diff） | events 折叠 write/edit | 每文件 diff 视图（+N/−N、行级着色） |
| 8 | 文件树浏览 | /v1/fs | 会话侧的懒加载文件树 |
| 9 | 斜杠命令 + 全局命令面板 | /v1/commands、/v1/session/:id/command | 输入框支持 / 命令；Ctrl+K 面板 |
| 10 | skills 目录（元数据→按需加载正文） | /v1/skills[?name=] | 列表 + 点开看正文 |
| 11 | agent 角色目录 | /v1/agents | 列表（角色/工具白名单/模型） |
| 12 | 模型与供应商管理（预设切换/模型列表/预算） | /v1/settings、/v1/models | ccswitch 式预设卡 + 原子切换 + 预算字段 |
| 13 | 用量分析（热力图/排行/成本） | /v1/usage | 统计卡 + 热力 + 会话排行（点击跳会话） |
| 14 | 定时任务（自动化） | /v1/schedules 全套 | 启停开关/立即执行/节奏/两步删除 |
| 15 | 记忆（列表/搜索/删除/写入） | /v1/memory | 搜索 + 条目卡 + 删除 |
| 16 | 子智能体目录（辅助对话） | parentId、role=butler、spawn/wait/followup | 子会话树形缩进 + 分叉标记；状态细化：运行中/等待/已阻塞/已完成/失败/已取消/已丢失；支持从面板对子代理发起追问 |
| 17 | 多会话并行状态 | sessions 轮询 status | 侧栏状态点（进行中脉动/中断红） |
| 18 | 通知（回合完成/需审批） | 客户端 Notification | 可开关，localStorage 记忆 |
| 19 | 深浅主题 + 跟随系统 | 客户端 | 首屏无闪烁（index.html 内联预置） |
| 20 | 快捷键体系 | 客户端 | Ctrl+K 面板等；按键提示可见 |
| 21 | 引导（无密钥/无工作区时）+ 工作区引导 | /v1/settings | 空状态指路设置，不白屏；「打开文件夹 / 从空目录开始」的工作区引导（web 手输路径，desktop 用系统文件夹选择器） |
| 22 | 图片附件 | prompt 的 images 参数 | 粘贴/拖放/文件选择进 composer，缩略图可移除；仅随最后一条用户消息降低（见 §6.4） |
| 23 | 导出/分享会话 | events 折叠 | 转录导出为 Markdown 下载（客户端折叠，不加端点） |
| 24 | i18n（中/英切换） | 客户端 | 文案表集中管理，默认中文，可切英文并记忆 |
| 25 | @文件引用 | /v1/fs | composer 里 @ 唤起文件选择，客户端把相对路径拼进 prompt（不做服务端展开魔法） |
| 26 | 跨进程会话目录 | /v1/live | 多运行时并存时的目录视图（弱需求，可最后做） |
| 27 | 桌面端打包 | Tauri 2 + sidecar | 见 §0/§7.8，web 验收后执行；同一 dist 同源即可 LAN/手机访问 |
| 28 | 富内容渲染 | 客户端 | Markdown 之上的 Mermaid 图表（缩放/平移）、表格增强（复制 Markdown 表格 / 下载 CSV） |
| 29 | 错误边界 | 客户端 | 区域级 React error boundary：单区出错可重试、不白屏；全局兜底页 |
| 30 | 会话调试信息 | 客户端 + §5.1 | 复制会话 ID / 事件日志说明；转录异常时的「重载会话」 |
| 31 | 对话引用 | 客户端 | 把历史消息片段引用进新 prompt（客户端拼文本，设条数/长度上限，如 8 条 / 8000 字符） |
| 32 | 应用内更新（桌面阶段） | Tauri updater | 检查更新 / 下载进度 / 重启安装 / 跳过此版本；更新前提示进行中会话会被中断 |

**明确暂缓**（ZCode 有、引擎暂无对应接口，不要自己造后端，也不要在客户端里埋业务逻辑）：内置终端；进程监视器 / 性能录制 / Agent stdio 抓取；PDF/Office/演示文稿/图片/代码内容预览面板（引擎只有 /v1/fs 单层列举，**没有文件内容读取端点**——代码面板整块等引擎补）；账号登录体系（用户名密码 / 扫码 / 多 Provider 登录，newhorse 只用 token）；IM 渠道机器人（微信 / 飞书 / 钉钉 / 企业微信 / Telegram / Webhook / Discord 全家桶，含绑定码与回复颗粒度）；模型调用轨迹落盘（model-io 逐次调用与来源分类）；回合级文件快照对比；画板（白板）；仓库 Wiki 生成（含 Mermaid 架构图批量生成与 Wiki 引用）；插件市场；git 深度集成（暂存/提交/推送/分支切换/Git 图谱/分支比较——ZCode 自己这块也还是前端占位）。清单外的新能力先问引擎有没有端点，没有就记入暂缓。

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

### 5.5 传输细节契约（数字都从 server/core 源码核过，别凭感觉实现）

**图像管道（端到端）**：
1. 客户端读取文件 → `arrayBuffer` → **裸 base64（不带 `data:` 前缀，标准字母表）**；渲染时才拼 `data:${mime};base64,${data}`。
2. 建议客户端先压缩/缩放再发（上限很容易顶到）；`HEIC/AVIF` 等不在白名单，前端要转码或拒绝。
3. `POST /v1/session/:id/prompt` body `{text, images?: [{mime, data}]}`。服务端校验（每条都是显式 400/413，不静默丢弃）：
   - mime 白名单 `/^image\/(png|jpeg|webp|gif)$/`；
   - base64 形状 `/^[A-Za-z0-9+/]+={0,2}$/` 且长度 %4==0，单张 ≤ **4,000,000** 字符（`MAX_IMAGE_BASE64`）；
   - 最多 **5** 张/条（`MAX_IMAGES_PER_PROMPT`）；
   - 整个 body > **40,000,000** 字节时**解析之前**就回 413（`MAX_PROMPT_BODY`，必须先查 Content-Length 再读流）。
4. 存储一次原则：图像只随 `Session.PromptAdmitted` 落盘一次，`Prompted` 事件重放它；转录折叠时从 admitted 行解析——**客户端不要在两条事件里重复渲染**。
5. **老化规则**：图像只在**最后一条用户消息**上降低给模型（防上下文膨胀），但历史消息的图像在 UI 里仍可展示（数据在事件里）。

**SSE 契约**：首帧是注释 `: open`（Bun 首个 body 字节才刷响应头，没有它客户端读不到 200）；每 15s 一条 `: keepalive` 注释（Bun 默认 10s 空闲断连，注释帧保活）；事件帧 `data: {json}\n\n`；终止 `data: [DONE]`；**客户端 abort 会触发服务端 interrupt**（回流干净，不会留半开连接）。

**鉴权**：服务端 token 来自配置/env（`NEWHORSE_TOKEN`），客户端存 localStorage 同名键，全部请求带 `Authorization: Bearer …`；401 = 未授权/未配置。

**事件日志读取**：`GET /v1/session/:id/events` 每次返回**全量数组**（无游标/增量），客户端全量重折即可（几百条以内开销可忽略）；`seq` 是聚合内单调序，**用户事件的 seq 就是 fork 点**；`ts` 是存储层写入时间，旧数据可能缺失（渲染要容错）。

**admission 语义（steer/queue）**：`POST /steer` 落一条 `delivery:"steer"` 的收件（下一个安全边界晋升）；进行中直接再发 prompt 会被当成排队（`delivery:"queue"`，会话空闲时晋升）。admit 是幂等的：同 id 同内容返回同一回执，同 id 不同内容报冲突；收件箱从事件日志重建，**重启不丢**。

**settings 合并语义**：PUT 是深合并（按字段）；`baseUrl/model/contextWindowTokens/maxOutputTokens` 等是 CLEARABLE（传 `""` 或 null 清空存储值，用于预设切换）；apiKey 按字段保留——**脱敏回显（hasApiKey/apiKeyHint 只是展示字段）往返绝不擦掉已存密钥**（有回归测试钉着）；密钥留空 = 保持不变。

**会话状态机**：`created → active → settled | interrupted`（registry 折叠自事件）；UI 只需要三态渲染：active=脉动点、settled=灰点、interrupted=红点。

**fork**：`POST /v1/session/:id/fork {atSeq?}` 复制前缀事件到新会话并**继承源会话的 workspace 与 role**；不带 atSeq = 从当前头部分叉。

**协议杂项**：所有 JSON body `content-type: application/json`，解析失败显式 400；错误响应形状统一 `{error: string}`；SSE 内错误是 `{type:"error", code, message}` 事件（HTTP 层可能已 200）。

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
5b. **§1.5 功能清单逐项核对，缺一项不算完**。
6. `bun typecheck`、`bun run build` 过；无密钥冒烟（fake-llm 或 client-surfaces）过；浏览器逐页截图自验。
7. 提交推送 dev；纯前端改动不用同步镜像。
8. web 验收通过后**打包 desktop**：Tauri 2 + server sidecar + 内置 dist（历史配置 `git show ff81b663f -- apps/desktop` 可整体恢复作参考），产出安装包，并验证深浅主题与球动画在 WebView 里正常。

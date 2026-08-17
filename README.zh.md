<p align="center">
<pre>
██      ██  ██████████  ██      ██  ██      ██  ██████████  ████████    ██████████  ██████████
████    ██  ██          ██      ██  ██      ██  ██      ██  ██      ██  ██          ██
██  ██  ██  ████████    ██  ██  ██  ██████████  ██      ██  ██████      ████████    ████████
██    ████  ██          ████  ████  ██      ██  ██      ██  ██  ██              ██  ██
██      ██  ██████████  ██      ██  ██      ██  ██████████  ██    ██    ██████████  ██████████
</pre>
</p>

<p align="center"><strong>newhorse</strong></p>
<p align="center">一个本地优先、可编程的 AI 工作空间，用于项目协作、个人连续性和多端智能体工作流。</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## 概览

Newhorse 是一个独立的 [OpenCode](https://github.com/anomalyco/opencode) 分支，把编码智能体运行时扩展成更完整的工作与生活环境。相同的运行时同时支撑桌面端、Web 端、TUI、SDK、自动化、模型、工具、MCP Server、Session 和 Workspace。

> newhorse 是**作者为个人工作习惯打造的个人工具** —— 单所有者工作空间，不是团队产品。

同一套运行时下有两种产品 Profile：

- **Assistant** 面向项目执行：代码、文件、终端、研究、计划、任务和 Workspace。
- **Companion** 面向个人连续性：关系感知对话、已确认的记忆、提醒、跟进与主动关怀计划。

Profile 不是存储边界。持久内容会按作用域和策略隔离：项目内容留在项目/Workspace 域，个人和关系内容留在个人域。

## 核心能力

### 完整的智能体工作空间

- Desktop、浏览器与终端界面
- Project Session、Git Worktree、Personal Workspace、Tab、Terminal、文件 Review、LSP 与 Command
- 多个前台/后台 Agent 及 Tool 委托
- MCP Server、Skill、Plugin、自定义 Command 与权限控制
- 服务端动态模型目录，按 Provider 可用性过滤
- 多 Provider 认证与模型偏好，不依赖前端硬编码列表
- 自定义 Provider 支持三种协议 —— OpenAI Completions、OpenAI Responses、Anthropic Messages —— 并提供一键「获取模型」按钮，从其 `/models` 端点自动发现模型列表
- Provider 余额/额度查询（OpenRouter `/api/v1/credits`、DeepSeek `/user/balance`），显示在设置 → Provider 中，基于内置可信模板而非用户脚本沙箱
- 原生代码评审引擎（diff 解析、确定性文件过滤、行级 AI 评论）
- 基于 ast-grep 的结构化代码搜索，以及拆分后的 LSP 工具（定义、引用、重命名、符号、诊断）
- 浏览器自动化工具（agent-browser），支持交互式 Web 任务

### Assistant 与 Companion

- Session 对 Workspace 与 Profile 的不可变绑定
- 唯一固定 Companion Session 固定在 personal 工作区，与当前打开的项目解耦
- 可配置 Companion Persona、Quiet Hours、主动频率与安全上下文
- 结构化 Memory，无审批生命周期：提取与工具保存的记忆立即生效，并可在 Memory Center 编辑/删除
- 持久 Reminder，支持创建、暂停、恢复、取消、lease 与幂等投递
- Follow-up 调度与 Companion Plan，统一管理 Memory、Reminder 和 Continuity Grant
- 每日活动总结：基于 newhorse work、newhorse、Claude Code 和 Codex 的当日会话，用 LLM 生成一天一条的总结，本地时间 23:00 后自动生成一次
- Todo 续跑执行器：一轮结束后仍有未完成任务时自动恢复继续工作
- 多模型回退链：主 Provider/模型不可用时自动切换到可用的后备
- 自动接受权限支持 Session、Lineage、Directory 优先级

### 内容隔离与信任

- 基于 SQLite 的结构化 Memory，包含 Scope、Provenance、Status、Expiration 及 Profile/Workspace 绑定
- Project 内容不会流入 Personal 或 Relationship Memory
- Relationship Memory 不会流入 Project 上下文
- 只有 Policy 允许的 Global Preference 才可投影到工作域
- Personal Workspace 保留完整编程工具；风险动作由明确的 Policy 控制，而不是删减能力
- Personal 上下文中的外部 MCP、Plugin 与 Skill 加载采用 opt-in

## 架构

Newhorse 将智能体产品中常被混在一起的职责拆分为：

| 层 | 职责 |
| --- | --- |
| Runtime | Session、Model、Agent、Tool、MCP、Skill、Memory、Scheduler |
| Orchestration | 前台/后台 Agent 组之间的委托与协同 |
| Workspace | Project、Worktree、Personal 环境及执行位置 |
| Content Scope | 持久信息的归属与存储域 |
| Policy | 权限、扩展加载与跨域信息流 |
| Profile | Assistant/Companion 体验、Persona、Memory 行为与主动性 |

主要 Package：

- `packages/opencode` — CLI、Server、Runtime、Session、Tool、Worktree、Policy、Memory、Reminder 与 HTTP API
- `packages/app` — SolidJS 产品 UI 与 Playwright 测试
- `packages/desktop` — Electron Desktop 宿主与安装包
- `packages/tui` — 终端界面
- `packages/sdk/js` — 自动生成及手写的 JavaScript/TypeScript SDK
- `packages/ui`、`packages/session-ui` — 通用 UI 与 Session 组件
- `packages/web` — 营销/文档站点，不是产品 Web Client

## 在 OpenCode 基础上优化了什么

Newhorse 以 OpenCode 运行时为基础，在其上加装了面向个人连续性、确定性工具和生产级加固的 newhorse 专属能力：

**记忆与个人连续性**
- 结构化 SQLite 记忆，覆盖四个内容域 —— project / personal / relationship / user-global —— 带溯源、状态与过期（Memory Center）
- 自动提取立即生效（无需人工接受/拒绝）：提取与工具保存的记忆直接激活，可在 Memory Center 编辑/删除
- 提取会把记忆分类为项目上下文或 user-global 偏好，项目指令保持项目域内，绝不提升为跨项目偏好
- Companion 与工作会话都会把记忆注入上下文（Companion：relationship 记忆；工作：project/user-global 记忆），不只是按需工具查询
- 记忆写入遵循 agent 的有效权限（拒绝的 `memory.save` 也会阻止自动提取）；工具/提取保存会把有效规则集传给信任策略
- Prompt 缓存前缀友好：稳定的系统提示（身份/环境/指令/技能/persona）作为缓存段；动态记忆/连续性放在断点后的独立段，记忆变化不会使缓存前缀失效
- FTS5/BM25 检索 + 实体提取与加权 —— **无需嵌入模型**
- 持久 Reminder、Follow-up、Continuity Grant 与 Companion Plan
- 每日活动总结（覆盖 newhorse、Claude Code、Codex 会话，含归档未删除会话）；显示在会话右侧面板与侧边栏，支持立即生成按钮与 agent 查询工具
- 独立每日报告页（`/daily`）：AI 概览 + 确定性工作产出（文件/增删行数）、带待办状态的会话明细、用量/成本汇总，以版本化 JSON 存储并向后兼容旧纯文本总结
- 每日总结按天记录并保留：daily-summary 以日期为主键，每天 23:00 后自动生成（含前一天回填），时间线展示完整历史
- Companion 语气示例驱动（短指令 + 五个中文 few-shot 对话，覆盖闲聊/求助/情绪优先/不确定/幽默），采用行为默认人格而非规则堆叠
- 记忆提取观测性：每个自动提取 gate 都会记录跳过原因，便于诊断「为什么没有提取记忆」
- Companion 会话「清空聊天记录」= 乐观清空显示 + 后台非阻塞压缩为隐藏上下文（保留连续性，不显示压缩内容）
- Todo 续跑执行器（idle 且有未完成任务时自动恢复）
- 记忆中心提供「全部工作区」聚合视图：只读、按工作区分组，列出各工作区的 project/personal 记忆与 user-global 偏好（relationship 记忆仍仅限当前 profile 可见——跨工作区只读不破坏隔离）
- 记忆工具完全自助：agent 可 `save`/`forget`/`archive`/`clear`/`consolidate`，并新增 `update`（就地修正内容/类别，保留 id 与来源）——模型可自主维护长期记忆的准确性，无需用户去记忆中心操作
- 记忆提取节流（每会话 5 分钟）并按重要性分级：LLM 给每条提案评 high/medium/low，low 级事实在入库前就被丢弃，聊天刷屏不会挤占真正重要的记忆槽位（每日软上限只是兜底）。提取关闭 prompt 缓存写入：后台提示与主对话共用同一 session 缓存键但前缀不匹配，写入缓存断点只会驱逐主前缀（此前曾把缓存命中率打到 40% 左右）；日期也移出缓存稳定前缀，跨天不再使整段缓存失效

**newhorse 工作台（仅 Companion 模式）**
- 独立工作台页面（`/workbench`）：感知条、个人待办、完整每日总结历史、用量统计一页聚合
- 工作台 v2 布局：顶部 90 天贡献热力图全宽展示，下方两栏（感知+待办 | 用量+每日总结时间线），窄屏自动折叠为单栏；数据刷新时保持滚动位置，页面不会跳回顶部
- 真实感知：桌面端上报系统前台应用、锁屏与会议状态（Win32 前台窗口探测，请求驱动 + 15s 缓存，无常驻进程）；服务端提供 `POST /presence` 端点 + 内存 Ref，局域网/手机端读取同一实时信号；Web 端回退为会话活动推导的空闲时间
- 个人工作台待办：用户自建或 newhorse 代建（`workbench` 工具），带状态机（open → in_progress → done/cancelled）、优先级、截止时间、按目录隔离
- Companion 上下文注入当前待办（按优先级取前 5 条），newhorse 可在对话中直接处理
- 工作台入口仅 Companion 显示：固定标签页与 home 侧边栏入口在 work（assistant）会话中隐藏
- 会话标题自动刷新：默认标题的会话每 N 轮从最近对话重新生成标题（可配 `experimental.session_title_refresh_interval`）；用户改过的标题永不被覆盖

**确定性工具与智能体**
- 原生代码评审引擎（精确 diff、确定性文件过滤、行级 AI 评论、falsify 过滤）
- ast-grep 结构化搜索/替换；拆分后的 LSP 工具（定义/引用/重命名/符号/诊断）
- MultiEdit 批量编辑；浏览器自动化（agent-browser，按需下载）
- 多模型回退链（可用性感知解析）+ 每 provider 熔断器（三态：连续失败/错误率双判据、半开单探测）：回退链跳过已熔断的 provider，显式路由的请求快速失败而非白等超时
- 四模式自我调度：`researcher`/`writer` 可被 `task` 委派，稳定系统提示注入 subagent_meta 委派表，build 可用 `plan_enter` 进入 plan 模式；spawn 出的子代理无法再委派（task 强制 deny），委派深度单调（持久 header 防 resume 绕过）
- 执行期插件 Hooks（权限决策、轮末续跑）
- 跨会话 Plan 恢复（boulder-state）
- 工具稳定性加固：失效工具调用产出一次明确的模型可见失败（不再 `invalid` 死循环）；legacy 每条消息的 `tools` 表无法再清空整个工具集；Windows PowerShell 子进程输出强制 UTF-8
- 上下文压缩展示友好化：压缩点渲染为单行折叠 marker（「已压缩 · N 条消息 / M tokens」），展开才显示模型摘要——checkpoint 载荷绝不作为普通 assistant 输出，被压缩的原始对话保留在 marker 上方可滚动回看；摘要指令作为 FINAL user message 追加（前缀缓存友好）。摘要生成中先显示「压缩中」spinner；消息/ token 数由压缩区间真实统计；marker 仅右侧 chevron 可展开（整行点击不再误触）
- 工作链路轨迹可视化 + 缓存指标：每个会话带轨迹时间线（轮次边界、工具调用输入/输出/错误高亮、subagent 行），点击跳回对应消息；上下文仪表显示 system/tools/messages 构成与预计下一轮 token，stats 行显示实时缓存命中率（`cacheRead / (input + read + write)`）——全部来自会话用量归档
- Goal 一级概念：`goal` 表 + 服务状态机（open → in_progress/blocked → done/cancelled）+ `goal` 工具 + plan 文件关联 + 标 done 前必填 `done_reason` 审计
- Todo 续跑上限：后台自动恢复在 `experimental.todo_continuation_max_iterations`（默认 100）次后停止；用户活动通过 2s 倒计时取消待注入；消息级中止检查作为现有事件中止检测的兜底
- 崩溃恢复与会话不变量：repair 通道在任何消息加载/恢复前闭合悬挂的中断轮次（合成 tool/result 失败并提示「只重试幂等工具」）；核心 append 路径以两阶段暂存校验事件 seq/step/工具配对不变量，非法事件不落库
- Prompt 缓存加固：长历史每 ~40 条消息加中间断点（受 provider 上限约束），缓存被驱逐时只需重发一个窗口而非整段日志；MCP 指令块确定性排序，重连不会打乱缓存前缀；超大工具输出截断到 50k 字符再进模型上下文（完整输出保留在会话日志）；多步轮次的 token 用量跨工具轮累加（此前只保留最后一步）
- 记忆提取等后台 LLM 调用关闭缓存写入，避免驱逐主对话前缀

**信任与安全**
- 中央信任策略 + 无内容审计；project/personal/relationship 内容域隔离
- 敏感内容拒绝 + 记忆策略门控
- 执行期权限决策开放给插件

**桌面与产品**
- 托盘常驻后台模式：关闭动作可选（退出或最小化到托盘，可选记住选择）；最小化始终回到任务栏，只有关闭才驻留托盘
- 工具描述汉化
- 原生代码评审展示在 app 的 review tab
- 删除会话后其 token/费用仍保留在用量统计中（session_usage 归档表 + /session/usage 端点；usage tab 合并活跃与归档用量）
- 用量统计准确且实时：token/费用直接来自各 provider 的 usage 报告（对所有协议归一化为 fresh-input 语义），而非代理端估算；会话上下文面板的 费用 / 缓存命中率 / 上下文 三项会在每次 step-finish 后通过发布的 `session.updated` 事件就地刷新
- Companion 会话可改名：固定 Companion 会话支持重命名，改名后标题栏保留自定义名称
- 移动端多端访问复用 Web：绑定 `0.0.0.0`（`--hostname 0.0.0.0` 或 mDNS），用 `OPENCODE_SERVER_PASSWORD` 认证（局域网绑定强制要求密码，未配密码拒绝启动）或 `auth_token` URL，页面可安装为 PWA（manifest + 纯网络 service worker，绝不上缓存含认证的响应）
- 桌面设置页新增「局域网/手机访问」面板：开关（关=loopback+随机密码，开=`0.0.0.0`+用户密码，未设密码拒绝开启）、局域网地址与可复制的 `auth_token` URL、端口/密码配置持久化到应用 store
- 局域网面板只列可访问的真实地址：VPN/TUN/链路本地网卡（172.16-31.x、198.18.x、169.254.x、CGNAT 100.64.x）会被过滤，复制出来的就是 WLAN 实际 IP；同时为局域网端口自动添加 Windows 防火墙入站规则
- 对话消息流内 Mermaid 直接渲染：```mermaid 代码块变 SVG 图（v11），主题跟随当前 UI 配色（明/暗各一套，浅紫兜底），TUI 内联 ASCII 渲染，失败回退为可复制代码块，始终提供「复制源码」入口
- 会话侧边面板跟踪后台 subagent 任务状态（running/completed/error），完成时批量 toast 通知
- TUI 输入框 Markdown 自动续写：`1. 文本`、`- 项`、`> 引用`、Tab 缩进后回车自动续行（`2. `、同符号、`> `、Tab）；空列表项回车退出列表而非留下裸前缀

**自我认知与文档**
- Agent 身份自感知：系统提示词身份为 newhorse；内置 `newhorse-capabilities` skill 在 agent 回答「newhorse 能做什么」时读取内置清单，不再 WebFetch 外部文档
- 内置配置 skill 由 `customize-opencode` 更名为 `customize-newhorse`：内容改为 newhorse 配置文档（newhorse.json / .newhorse / ~/.config/newhorse，opencode 路径标记为 legacy）

其中多项移植自或参考自开源参考项目（OpenCodeReview、oh-my-opencode、mem0、Claude Code 的格式），并遵守其许可证。

## 当前状态

Newhorse 仍在持续开发中。当前支持源码构建、本地 Web/Desktop 开发、便携 CLI 导出和未签名 Desktop 安装包构建；尚未发布包管理器版本或公开签名安装器。

主要基础能力已经落地：

- Central Trust Policy 与不含内容的 Policy Audit
- Assistant/Companion Profile 与 Personal Workspace
- 结构化 Memory、Reminder、Follow-up、Continuity Grant 与 Companion Plan 管理
- 每日活动总结（Session Reader、23:00 调度器、HTTP list/generate、Sidebar 时间线，含归档未删除会话）
- 结构化每日报告页（`/daily`）：AI 概览 + 工作产出 + 会话明细（含待办）+ 用量成本，JSON 存储且向后兼容旧纯文本总结
- 服务端动态 Model/Provider Catalog
- 仅保留 v2 布局（已移除旧界面及其退役迁移机制）
- 记忆检索升级：FTS5/BM25 检索、实体提取与加权、回合后自动提取且立即生效（无审批门控）
- 记忆分层：四个内容域（project / personal / relationship / user-global），自动迁移既有记忆
- 记忆无审批：提取与工具保存的记忆直接激活；Memory Center 支持编辑/删除/暂停，按域标注，无接受/拒绝步骤
- 工作会话记忆注入：assistant 会话在上下文中获得 project/user-global 记忆，不只是按需工具查询
- 记忆权限端到端生效（拒绝的 memory.save 同样阻止自动提取）；Memory Center 可见性通过 personal 域迁移修复
- LSP / follow / 浏览器自动化端到端接通（此前是不可达的死链），浏览器二进制首次使用自动下载
- 连续性自动提议（companion/assistant 轮次后自动提议，注入前仍需批准）
- 主动关怀自动触发（启用时）：空闲 check-in，内容由每日总结与近期记忆动态组成，遵守静默时段与频率上限
- Prompt 缓存前缀友好（稳定系统提示缓存；动态记忆/连续性在断点后的独立段）
- 执行期插件 Hooks（权限决策、轮末续跑）
- 桌面端托盘常驻（关窗进托盘，Server 与后台 Agent 持续运行）
- Agent 选择器 UI 优化（下拉加宽、两行条目）与 add-server 对话框输入不再冻结
- 工具描述汉化
- Linux 与 Windows 便携 CLI 导出
- Windows NSIS 与 Linux Desktop 打包路径
- newhorse 身份与能力自感知（系统提示词身份为 newhorse；内置 newhorse-capabilities skill）
- 内置 customize-newhorse skill 替代 customize-opencode（newhorse 配置路径；opencode 路径标记 legacy）
- 用量归档：删除会话后其 token/费用仍计入用量统计（session_usage 归档表 + /session/usage 端点；usage tab 合并统计）
- 记忆提取观测性（每个 gate 记录跳过原因）
- Companion「清空聊天记录」= 乐观清空 + 后台隐藏压缩（保留连续性）
- Companion 会话可改名
- 记忆中心「全部工作区」聚合视图（只读、按工作区分组；relationship 仅当前 profile 可见）
- newhorse 工作台（`/workbench`，仅 Companion）：感知条 + 个人待办（自建 + newhorse 代建）+ 完整每日总结历史 + 用量；固定标签页与侧边栏入口在 work 会话隐藏
- 默认标题会话自动刷新标题（可配间隔；用户改名永不被覆盖）
- 上下文压缩单行 marker（折叠，展开显示摘要；checkpoint 载荷不内联渲染）
- 移动端多端访问：局域网绑定强制密码、auth_token URL、PWA 安装（纯网络 service worker）
- 四模式自我调度（researcher/writer 委派、subagent_meta 委派表、plan_enter、委派权限下沉、深度单调）
- 回退链每 provider 熔断器 + 显式路由熔断快速失败
- 工具稳定性加固（无 invalid 死循环；legacy tools 表无法 deny-all；PowerShell UTF-8 输出）

每日总结已上线并显示在 Sidebar 时间线中，完整的结构化每日报告可在 `/daily` 页面查看。macOS Desktop 运行验证以及生产签名/notarization 仍属于发布门槛。

## 环境要求

- [Bun](https://bun.sh) 1.3.x
- Git
- Electron Builder 所需的平台构建工具

## 从源码构建

```bash
git clone https://github.com/Lin-A1/newhorse.git
cd newhorse
bun install

# CLI/Server 开发
bun run --cwd packages/opencode dev

# 产品 Web UI 热更新
bun run dev:web

# Electron Desktop 开发
bun run dev:desktop
```

产品 Web UI 由 Newhorse CLI/Server 提供服务。`packages/web` 是独立的营销与文档站点。

## 产品命令

根目录的产品编排器会委托现有 Package Script，并跟踪 Target 就绪状态与产物指纹：

```bash
bun run product targets [--json]
bun run product doctor [--target <id>]
bun run product web [--source]
bun run product dev <cli|web|desktop>
bun run product build [--product cli|desktop|all] [--target <id>]
bun run product export [--product cli|desktop|all] [--target <id>] [--execution local|ci|auto] [--force]
bun run product verify --artifact <path>
```

Target 状态的含义如下：

- **configured** — 构建配置存在
- **exportable** — 存在本地或 CI 导出路径
- **verified** — 产物已在目标操作系统成功运行
- **signed** — 平台签名/notarization 已完成
- **releasable** — 产物已验证、已签名，并获得发布授权

本地打包成功不会自动被视为 signed 或 releasable。

## 测试

请在 Package 目录内运行测试，不要从仓库根目录运行。

```bash
bun run --cwd packages/app typecheck
bun run --cwd packages/opencode typecheck
bun run --cwd packages/opencode test
bun run --cwd packages/opencode test:httpapi
```

## 贡献

中文版本见 `README.zh.md`。提交代码时尽量保持改动聚焦，优先使用小而清晰的补丁。
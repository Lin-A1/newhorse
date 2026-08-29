# M4 Spec：执行权限细化（execpolicy）

日期：2026-08-29
状态：**已实现（M4 execpolicy 核心）** — 规则引擎（最长前缀/路径归一）+ 危险启发式地板 + 交互 approve 30s fail-closed 闸 + 审计（`Session.ExecDecision`）+ 禁止规则路径自引用已落地（runtime/tools/execpolicy.ts）。自举写回（`bootstrapAppend`）已实现但未接线到 approve 流程（deferred）；"已通过四轮独立锐评"为实现前的评审记录，实现后 docs §14 记录了 14 轮 closed-loop review。

上游借鉴：OpenAI Codex `exec_policy.rs`（规则引擎 + 决策单轴 + 自举写回）；newhorse M3.5 内置工具集；m2b 但管权威（会话层）。
实现决策见 `docs/core-technology-notes.md` §14。

> 轮次记录：
> - 首轮：需修正后实施（5 项）。
> - 二轮修正稿：仍须修正（6 项）。
> - 三轮修正稿：仍须修正（2 项：win32 平台维度 / 规则最长前缀语义）。
> - 四轮修正稿：仍须修正（2 项本轮 must-fix：**B1 win32 漏 `powershell -EncodedCommand`/`pwsh`/`cscript`/`regsvr32` 任意代码主向量**（且与 §8 必测 3/8 自相矛盾）、**B2 `decidePath` 路径未归一使 `.newhorse/**` 恒 forbid 可能失效**）。本版为第五修正稿，闭合 B1/B2 + 吸收 S1/S2/S3。

---

## 0. 定位与要解决的问题

M3.5 给了 agent "手"（read/write/edit/list/search/bash），但**授权只剩一个 `enableBash` 裸开关**——这是明确的安全敞口：

- `write` 可以落一个 `.ps1`/`.bat` 供后续执行 = "任意执行的半张门票"（M3.5 §2.2 已标注）。
- `bash` 一旦开启就**不受 fs 沙箱约束**，能 `cd ..` 读任意可达路径、写任意可达文件。
- 没有任何"模型想跑某条命令 / 改某个敏感路径时，先裁决能不能、要不要先问"的机制。

**M4 execpolicy 要解决的**：把"模型何时能执行一个动作"从**裸开关**升级为**规则驱动的授权轴**，且授权决策由**宿主态规则**决定——不信任 LLM 自报权限、自降门槛。

与 m2b 但管权威的关系：**正交，但工具层是兜底**。
- 但管权威（m2b）= **会话层**：`send_to_session`/`interrupt`/`spawn` 这类"动别的会话"的操作，按 caller 等级授权。
- execpolicy（M4）= **工具层**：`bash`/`write`/`edit` 这类"动本机资源"的操作，按规则裁决。
- 两者可以且应当并存：一个但管会话 spawn 的子会话，执行 shell 命令时**仍受 execpolicy 约束**（子会话不能靠"我是但管的娃"绕过命令白名单）。

---

## 1. 授权轴（借鉴 codex 决策单轴，但承载 newhorse 的动作类型）

`Decision = allow < prompt < forbid`，**多规则命中取最严格**（`forbid > prompt > allow`）。这是整个模型的灵魂——不是二维矩阵，是单轴排序取 max。

**决策公式（钉死，全 spec 以此为准；`decide` 与 `decidePath` 统一适用）**：

```
final(action) = max( matchRules(action), heuristic(action) )
```

- `matchRules` = 命中规则原语取 `forbid > prompt > allow`，未命中 = `none`。
- `heuristic` = 危险兜底启发式，**恒应用，永不因规则命中而跳过**。规则只能在"启发式未命中"时决定 allow/prompt；启发式命中 prompt/forbid 时，规则**无法**用 allow 把它拉回来。
- **即：`allow` 只能出现在"启发式 + 已知规则都未防"处。任何被启发式标记危险的动作，规则永远不能升格为 allow。** 此条同时约束 `decide`（命令）与 `decidePath`（路径）。

**前缀规则匹配语义（钉死）**：`decide`（命令）对 argv 前缀求值时，采用**最长精确前缀优先**——`["git","push"]` 比 `["git"]` 更具体，先命中并覆盖更短前缀；仅当两个候选前缀**长度相同**才取 max；最终仍 `max(规则, 启发式)`。**解释器后的全局 option（如 `git -c k=v push` 的 `-c`）不作跳过**——它使前缀取不到具体子命令而命中更短前缀 → 安全 fail-closed（见 §4.1 S2）。**路径类**（`decidePath`）无前缀层级，规则命中即取 max 与启发式。

newhorse 的动作类型分两类，都走同一条轴，但范式和兜底不同：

| 动作类型 | 裁决对象 | 范式 | 未命中兜底 |
|---|---|---|---|
| **shell 命令** | `bash` 的待执行命令（argv，模型原始字符串） | `prefix_rule`（最长前缀）+ `network_rule` + `shell_wrapper`（拆包） + `host_executable` | 危险启发式命中 → prompt/forbid；**脚本文件执行/内联代码/shell 控制源类 → prompt**；**普通命令 → allow** |
| **敏感路径** | `write`/`edit` 的目标路径 | `path_rule` | 敏感后缀/目录 → prompt；`.newhorse/**` → 恒 forbid；**规则文件路径（dataDir 下）→ 恒 forbid**；其余普通路径 → allow |

> 关键：**路径普通写入默认 allow**（agent 每天都要写代码），但**敏感后缀/目录**（可执行脚本、凭据、配置）默认收紧。命令默认**收紧**（shell 天然危险），路径默认**宽松**（但敏感点收紧）——两者不平衡，因为风险不对称，借鉴 codex 的"三层控制面"思想。

### 命令兜底特判（防脚本落地 + 内联绕过 + 控制源注入，跨平台）

以下三类命令**不落入普通命令 allow 兜底**，统一 `prompt`（无交互 → forbid）：

1. **脚本文件执行**：argv 第一个 token 是**解释器**（清单见 §2 解释器表）**且**第二个 token 是一个脚本文件路径（如 `python x.py`）→ 内容未审，等价 `bash -c`。
2. **解释器内联代码**：解释器 **与** `-c`/`-e`/`--eval`/`cmd`/`command`/`-EncodedCommand`/`-enc` 之一同现（`python -c "..."`、`node -e "..."`）→ 任意代码执行，直接内联。
3. **shell 控制源/包装**：`eval`/`source`/`.`(dot)/`xargs`/嵌套 `sh -c`/`bash -c`/`powershell`/`pwsh`/`cmd /c` → **不可完全解析→倾向拒绝**（见 §2 拆包）。

> 二者共同构成"执行任意内容"的谱系——脚本文件、内联代码、源注入、脚本宿主。核心是非"读文件/跑已知工具"，而是"跑未审内容"。忽略任一，`enableBash=true` 下模型都能不经危险启发式执行任意代码。

> **解释器清单（B1 扩展，跨平台）**：`python`/`python3`/`node`/`nodejs`/`php`/`bash`/`sh`/`perl`/`py`/`deno`/`bun`/`ruby`/`powershell`/`pwsh`/`cscript`/`wscript`/`regsvr32`/`mshta`/`cmd`。凡 argv 首 token 在其中 → 按上述 1/2 特判（脚本文件执行或内联代码），不再落到普通命令 allow。
>
> **shell 类检测（比"以 `sh` 结尾"更准）**：shell `-c`/REPL/stdin 是任意代码，但判定用**有界命名集合**（`sh`/`bash`/`zsh`/`fish`/`dash`/`ksh`/`csh`/`tcsh`/`ash`/`yash`/`osh`/`mksh`/`pdksh`/`sash`/`cbash`/`ksh93`/`rush`/`nsh`/`posh`/`scsh` + `busybox`），并用 `shellBaseName` 规整版本/`-`/`.`/`.exe`（`ksh93`/`bash5.2`/`bash-5.2`/`zsh-5.8`/`dash-0.5` 都归到 `bash`/`zsh`/`dash`）——**不做** `*sh` 结尾通配，否则会把 `push`/`publish`/`grep sh`/`ssh`/`rsh`/`mosh` 误判为 shell。**扫描整条 argv**（而非只看 argv[0]）：凡某 token 是 shell/解释器名且（a）是执行头，或（b）后跟代码旗标/脚本路径，或（c）是 `awk` 族/`lua`/`tclsh` 这类"总吃程序"的解释器 → prompt。这样 `taskset bash -c id`/`runuser -u root -- bash -c id`/`chroot / bin/bash -c id`/`setarch sh -c` 等**未枚举包装器**后的 shell/解释器不再因包装词不在白名单而落到 allow（M4 末轮修正：用类检测关闭"包装器名穷举"漏洞）；`bash -s -c id`/`systemd-run bash -s -c id`/`runuser -u root -- bash -s -c id` 这类**被 `-s`/`-l`/`--` 掩码的 `-c`** 也落到 prompt；注意掩码旗标是**无操作数的布尔旗标、可无限重复**（`bash -s -s -l -c id` 把 `-c` 推到更远），所以向前扫描是**无界**的——任一 shell/解释器 token 之后**任何位置**出现代码旗标/脚本路径/重定向/下一解释器/`awk` 族都 prompt（否则固定窗口 k+1..k+3 会被第 4 个透明旗标绕过，M4 末轮修正）。文件名/路径参数（`grep foo.sh`/`cat x.py`）与"shell 名当作参数"（`grep bash file`、`git push ...`）不触发；版本化 shell 名（`bash5.2` 带 `.2`）是执行头而非文件，不被 `isPathLike` 过滤。注意：`awk` 族/`lua`/`tclsh` 这类"总吃程序"的解释器即使不吃参数、仅经 stdin（`awk < data.txt`）也会 prompt——它把 stdin 内容当程序执行。已知可接受的 fail-closed 误报：把 shell 名当普通文件名的参数（`ls bash file.txt`/`mv bash zsh`）会 prompt——安全但偏严，属保守取舍（M4 末轮确认与基线一致，未新增）。

### 决策来源（谁裁决）

- **配置文件**（宿主态规则文件，`dataDir/projects/<hash>/rules.json`）：预声明规则。
- **用户交互**：命中 `prompt` 时向 transport 发起 approval 回调用户；批准则执行，且**自举写回**一条 allow 规则（凭据类排除）。
- **无交互降级**：DAG 子会话 / 非交互 SDK 无法弹窗 → 命中 `prompt` 时**fail-closed 按 `forbid` 处理**（返回 `{ denied, reason }` 给模型），绝不静默放行。

---

## 2. 规则原语（5 个，而非"命令类别分级"）

借鉴 codex 的"规则类型而非品类"，newhorse 定义 5 个规则原语，全部注册在 seam 上（不是 if/switch 链），统一裁决：

```
type ExecRule =
  | { readonly type: "prefix_rule"; readonly pattern: string[]; readonly decision: Decision; readonly reason?: string }
      // argv 前缀匹配，如 ["git","push"] / ["npm","install"]；pattern 元素可含候选并集
  | { readonly type: "network_rule"; readonly host: string; readonly protocol: "http"|"https"; readonly decision: Decision; readonly reason?: string }
      // host+协议网络访问；触发点见 §4.1 network_rule 挂载点定义
  | { readonly type: "path_rule"; readonly prefix: string; readonly decision: Decision; readonly reason?: string }
      // 路径前缀/后缀匹配
  | { readonly type: "shell_wrapper"; readonly decision: Decision; readonly reason?: string }
      // 对 bash -c/-lc / powershell -Command / cmd /c 这类 shell 包装：能拆包则内部逐条评 + 取 max；否则按此 decision
  | { readonly type: "host_executable"; readonly path: string; readonly decision: Decision; readonly reason?: string }
      // 绑定具体可执行文件路径（绝对路径）——增强版防"PATH 劫持"，M4 可选实现

type Decision = "allow" | "prompt" | "forbid"
```

### 优先级（取最严格，且启发式恒为底线）

- 多规则命中同一动作 → **最长精确前缀优先**（命令）或同 length 取 max（见 §1 前缀语义）。
- `shell_wrapper` 拆包后，动作的最终决定 = `max(内部逐条子命令决定, 包装器自身决定, 启发式)`。
- **`shell_wrapper` 缺省 `decision = "prompt"`**（无交互 → forbid）。**能可靠拆包才逐条评；否则按更严处理（prompt/forbid），绝不放行。**
- **启发式恒应用，永不因规则命中 allow 而跳过**（§1 决策公式）。`allow` 只在"启发式 + 规则都未防"时成立。**此条同时适用于 `decide` 与 `decidePath`**。

### 危险兜底启发式（恒为底线，借鉴 codex `is_dangerous_command`，**跨平台**）

> **实现必须数据驱动**（数组 + 循环匹配），不得写成 if/else 链。每条携带 `reason`。**`DANGEROUS_COMMANDS` 按 `platform` 分支**（B1：win32 数组**必须 = posix 数组 ∪ win32 特有项**，因为 win32 也可能经 git-bash/`sh -c` 跑 POSIX 命令，且 `cmd /c` 也能调 posix 工具）。

```ts
// —— 平台无关高危（两类平台都适用，先并进去）——
const COMMON_DANGEROUS: Array<{ match: RegExp | string; reason: string }> = [
  { match: /\brm\s+-(?:r?)*f\b/,                    reason: "recursive force delete" },
  { match: /\bsudo\b/,                              reason: "privilege escalation" },
  { match: /\bcurl\b[^|]*\|\s*(?:sh|bash)\b/,       reason: "pipe remote to shell" },
  { match: />\s*\/dev\/null\b/,                     reason: "silenced output" },
  { match: /\bkill\s+-9\b/,                         reason: "force kill" },
  { match: /~\/\.ssh\b/,                            reason: "ssh key material" },
  { match: /\bchmod\s+777\b/,                       reason: "world-writable" },
  { match: /\b(curl|wget)\b/,                       reason: "remote network fetch" },
  { match: /\beval\b|\bsource\b|\bxargs\b/,         reason: "shell source control" },
]

// —— win32 特有高危（B1 必含）——
const WIN_SPECIFIC_DANGEROUS: Array<{ match: RegExp | string; reason: string }> = [
  { match: /\b(?:del|erase)\b[^|]*(\/[fsq]|-f)/i,    reason: "force delete" },
  { match: /\b(?:rd|rmdir)\b[^|]*(\/[sq]|-s)/i,      reason: "recursive delete" },
  { match: /\bformat\b/i,                            reason: "disk format" },
  { match: /\breg\s+delete\b/i,                      reason: "registry delete" },
  { match: /\bicacls\b/i,                            reason: "acl mutation" },
  { match: /\btaskkill\b[^|]*(\/f|-f)/i,             reason: "force kill" },
  { match: /\bnet\s+user\b/i,                        reason: "account mutation" },
  { match: /\bcertutil\b/i,                          reason: "cert manipulation" },
  { match: /\bmshta\b/i,                             reason: "html app exec" },
  { match: /\bwmic\s+process\b/i,                    reason: "process create" },
  { match: /\b(?:vssadmin|bcdedit)\b/i,              reason: "boot config mutation" },
  { match: /\bpowershell\s+(?:-enc(?:odedcommand)?|-e|-c|-E|-ec)\b/i, reason: "encoded/embedded powershell" },
  { match: /\bpwsh\b|\bcscript\b|\bwscript\b|\bregsvr32\b|\bmshta\b/i, reason: "script host exec" },
  { match: /\brundll32\b|\bmsiexec\b|\bforfiles\b/i, reason: "windows lolbin exec" },
]

// —— 最终危险表（B1 MUST：win32 = COMMON ∪ WIN_SPECIFIC，posix = COMMON）——
const DANGEROUS_COMMANDS: Record<"win32"|"posix", Array<{ match: RegExp | string; reason: string; decision: Decision }>> = {
  posix: COMMON_DANGEROUS.map(e => ({ ...e, decision: "prompt" as const })),
  win32: [...COMMON_DANGEROUS, ...WIN_SPECIFIC_DANGEROUS].map(e => ({ ...e, decision: "prompt" as const })),
}
```

- **调度**：`decide` 按 `bash.ts` 实际执行的平台（`process.platform`，call-time 读取，与 `bash.ts:52` 同一源）选 `win32` 或 `posix` 数组。win32 数组 = posix ∪ win32 特有（留 COMMON 里 `curl|sh` 等，防 win32 上 git-bash 跑）。
- **解释器清单**：见 §1。凡 argv 首 token 命中解释器清单 → 走 §1 命令兜底特判（脚本/内联），**不必**再靠 `DANGEROUS_COMMANDS`（DANGEROUS_COMMANDS 仍兜住解释器之外的复合/危险字符串）。
- **路径敏感后缀/目录**：`.ps1`/`.bat`/`.cmd`/`.pem`/`.key`/`.crt`/`.p12`/`.env` 命中即 `prompt`；`.newhorse/**` 恒 `forbid`；**规则文件路径（dataDir 下）恒 `forbid`**；其余普通路径 `allow`。
- **这些启发式硬编码为 forbid/prompt 倾向，不固化到规则文件**（不可被自举覆盖）。`BANNED_PREFIX`/`CREDENTIAL_SUFFIX` 同样数据驱动，且 `BANNED_PREFIX`（双平台）覆盖 `eval`/`source`/`xargs`/`python`/`node`/`powershell`/`pwsh`/`cscript`/`wscript`/`regsvr32`/`rm`/`sudo`/`curl`/`wget`/`del`/`format`/`reg`/`icacls`（防一次手滑被自举固化）。

### 规则文件恒不可被模型触碰（四重防线 + bash 补防 + 平台无关）

规则文件位于 `dataDir/projects/<workspace-hash>/rules.json`（宿主态，移出 workspace fs 沙箱）。它**仍可能在 bash 的射程内**（bash 不守 fs 沙箱）。防线覆盖 bash（win32/posix 都对）：

1. `decide()` 对 shell 命令做"**规则文件路径引用探测**"——命令**任一 argv 参数**引用 rules.json 路径或其父目录（**不分写/删/改**）→ 标 `forbid`（`BANNED_RULES_PATH` 数据驱动，S3）。覆盖 `echo > rulesPath`、`node -e "fs.writeFileSync"`（`-e` 同时命中内联特判）、`Remove-Item`/`del`/`rmdir` 作用于 rules 目录。
2. `.newhorse/**` 恒 forbid（write/edit 共用 `decidePath`，**路径归一见 §4.1 B2**）。
3. `read` 拒绝 `.newhorse/rules.json`（模型不能读边界）。模型读 dataDir 规则文件本身不构成提权（读过不比猜更强，与启发式对冲），重点是写/删。
4. **加载校验 fail-closed**：每次 `decide` 从磁盘重读（或版本号快照比对），读到即校验——规则里含 `BANNED_PREFIX`/凭据类/来源可疑 → 该规则弃用或整文件 fail-closed（deny-all）。防止"久未校验的规则文件被投毒后静默生效"。

**文档声明（残留风险，与 ADV-2/ADV-3 并列）**：
- `git push` 的 `--upload-pack`/`-c core.sshCommand` 参数注入属"git push 允许型残余风险"；
- `git pull`/`git fetch` 可触发远端仓库的 post-merge/post-checkout hook 执行任意代码（当前被归为 allow）——列入允许型残余；
- `git -c core.sshCommand=evil push`（全局 option）因 `-c` 前缀取不到 `["git","push"]` → 安全 fail-closed（有意收紧，不为此放宽）。

---

## 3. 自举（bootstrapping，借鉴 codex `append_amendment_and_update`）

批准一个 `prompt` 动作时，把该动作的**前缀**持久化成一条 `allow` 规则写回规则文件，下次同前缀免审。

- **禁令**：禁止把高危命令前缀固化为 allow——`bash`/`node`/`python`/`rm`/`sudo`/`curl`/`wget`/`sh`/`perl`/`eval`/`source`/`xargs`/`del`/`format`/`reg`/`icacls`/`powershell`/`pwsh`/`cscript`/`wscript`/`regsvr32` 等解释器/破坏性/网络/控制源/脚本宿主命令不写回（`BANNED_PREFIX`，双平台）。防止"一次手滑永续流"。
- **凭据类绝不写回**：写回前先查 `CREDENTIAL_SUFFIX`（`.env`/`.pem`/`.key`/`.cert`/`.p12`/`.crt`），命中则**绝不生成 allow path_rule**（硬性逻辑）。只有可执行脚本类（`.ps1`/`.bat`/`.cmd`）批准后可写回。
- **粒度**：只固化合法的 `prefix_rule`/`path_rule`，不固化 `network_rule`；不固化 `host_executable`。
- **作用域**：写回到**宿主态数据目录** `dataDir/projects/<workspace-hash>/rules.json`（per-project），**不是** workspace 内的 `.newhorse/rules.json`。
- **写入口唯一**：规则文件**唯一写入口是宿主态审批后的自举写回**。LLM 的 write/edit（`.newhorse/**` forbid）与 bash（`BANNED_RULES_PATH` forbid）都触碰不到。
- **并发写回原子性**：多会话同时自举写回同一文件 → 原子写（临时文件 + `rename`），且 per-project 只读一次加载、写回全量重写，避免丢/坏。**`decide`/`decidePath` 为纯函数**（只读加载后的不可变规则快照）；自举写回递增版本号，读到旧版本即重载。

---

## 4. 落点（在 newhorse 现有架构上的最小侵入）

> newhorse 已把工具授权做成 Tool 契约 + ToolCtx 注入（m2b）。M4 execpolicy 复用同一注入面，不重造。

### 4.1 工具侧

- **bash**：`execute(input, ctx)` 中，先经 `execPolicy.decide(command)` 裁决（输入是**模型原始字符串**；工具自身的 `cmd /c`/`/bin/sh -c` 包装只作执行层，不参与裁决）：
  - 命中 `forbid` → 返回 `{ error, denied: reason }`；
  - 命中 `prompt` → 走 `execPolicy.approve?(req)`（唯一审批入口）；无 approve 回调、超时、或用户拒绝 → 返回 `{ error, denied: reason }`；
  - `allow` → 执行。
  - **若 `ctx?.execPolicy` 为 undefined → 一律 deny**（防 fail-open）。`decide` 按 `process.platform`（call-time）选 win32/posix 危险表。
- **write/edit**：`execute(input, ctx)` 中，目标路径经 `execPolicy.decidePath(path)` 裁决；`forbid` → 拒绝；`prompt` → 同上；`allow` → 执行。**`.newhorse/**` 恒 forbid；规则文件路径恒 forbid**（两工具共用 `decidePath`）。**若 `ctx?.execPolicy` 为 undefined → 一律 deny**。
- **read/list/search**：只读，默认不受 execpolicy 约束（读是常态），路径仍受 fs 沙箱约束（M3.5）。**但 `read` 必须拒绝 `.newhorse/rules.json`**——`isLikelyBinary` 对文本 `.json` 拦不住，需单列硬拒绝。list/search 因 `.newhorse` 在 `EXCLUDED_DIRS`（`common.ts:6`）天然跳过。

#### `decidePath` 路径归一（B2，钉死）

`decidePath(path)` 收到的是**用户原始路径字符串**（`write`/`edit` 的 `input.path`，即 `resolveInWorkspace` 之前的值）。**内部归一**：

- win32 大小写折叠（转小写）；
- `\` → `/`（win32 分隔符归一）；
- 剥离前导 `./`；
- 对绝对路径（`G:\ws\...` 或 `/ws/...`）做**相对化/取 workspace 相对段**。

`path_rule` 前缀匹配、`.newhorse/**` 恒 forbid、`BANNED_RULES_PATH` 全部建立在**唯一归一参考系**上（全正斜杠、相对路径、小写折叠）。`.newhorse/**` 恒 forbid **额外**用「归一后命中 `/\.newhorse($|\/)/` 段落」兜底（不依赖 glob 语义），并**同时校验** `resolveInWorkspace` 后的绝对路径是否含 `/.newhorse/`——双保险。

> 范围说明：write/edit 目前签名是 `(input) =>`，不接收 ctx（`write.ts:24`/`edit.ts:32`）。M4 改签名为 `(input, ctx?)`。read/list/search 不改签名（不消费 execPolicy）。

#### `network_rule` 挂载点定义（R4）

- 触发：命令首 token 是网络工具（`git`/`curl`/`wget`/`ssh`/`rsync`/`scp` 等）且含 URL/远端/refspec 参数时，解析 `host` + `protocol` 命中有无匹配 `network_rule`。
- **host 解析**：`git push origin main`（用 remote 名，无 URL）→ host 解析不到 → 落入"已知 host 白名单"（`github.com`/`gitlab.com` 等）→ 按 `["git","push"]=allow` 放行。
- **`git` 读操作（log/status/diff/pull/fetch/branch/show/blame）**：显式 `prefix_rule` 补 allow，或归"普通命令 allow"（只对 `push`/`remote add`/`submodule` 走 network_rule），避免 DAG 非交互下 fail-closed 瘫痪。
- **`git -c k=v push`（S2）**：`-c` 使 `["git","push"]` 前缀取不到，只命中 `["git"]=prompt` → 安全 fail-closed。**不实现"跳过全局 option 找子命令"**——否则 `git -c core.sshCommand=evil push` 也会命中 `["git","push"]=allow`，等于放大残留风险。文档标注"有意 fail-closed"。
- **`curl`/`wget` 到未知 host** = forbid（写型外发）。承认"`git push` 是外发网络却放行"的轻微不对称，以开发常态为由接受，文档注明风险。

### 4.2 ToolCtx 扩展：core 缺省 deny-all + runtime 可选覆盖

```ts
// schema（纯类型）：
type Decision = "allow" | "prompt" | "forbid"
interface ExecPolicy {
  readonly decide: (cmd: string) => Decision
  readonly decidePath: (path: string) => Decision
  readonly approve?: (req: ApprovalRequest) => Promise<boolean>
}
interface ApprovalRequest { readonly id: string; readonly kind: "command" | "path"; readonly target: string; readonly decision: Decision; readonly reason?: string }

// core agent/runner.ts：
interface ToolCtx {
  // ...现有字段
  /** 执行授权轴。可注入（runtime 覆盖）；缺省由 loop 填充 deny-all（decide/decidePath 恒 forbid）。 */
  readonly execPolicy?: ExecPolicy
}
```

**关键决策**：`loop.ts:206` 装配 ctx 处改为 `execPolicy: opts.toolCtx?.execPolicy ?? denyAllExecPolicy`，其中 `denyAllExecPolicy` 定义在 **core**（deny-all：`decide`/`decidePath` 恒 `forbid`）。原因：规则引擎放 `runtime/src/tools/execpolicy.ts`，`loop.ts` 在 core，core 不能 import runtime。所以：
- **core 拥有安全的 deny-all 缺省**（缺省 deny 最安全）；
- **runtime**（`app.ts`/`dag-runner.ts`）通过 `toolCtx.execPolicy` 注入富策略（规则 + 启发式 + approve）；
- **`ToolCtx.execPolicy` 声明为可选**：`RunOptions.toolCtx`（= `Omit<ToolCtx,"caller">`）的 `execPolicy` 保持可选——未指定则兜死，不破坏现有只传部分字段的调用。运行时非空由 `loop.ts:206` 的 `?? denyAllExecPolicy` 保证。（`execPolicy` 键须放在 `...opts.toolCtx` spread **之后**，避免覆盖置回 undefined，N2。）
- **类型兼容**：`denyAllExecPolicy`（core）与富策略（runtime）都返回同一 schema `ExecPolicy` 结构类型，兼容；core 只 import `@newhorse/schema`，runtime 依赖 core+schema，无方向违例、无循环依赖。
- **`decide` 的 platform**：`decide` 在裁决时读 `process.platform`（call-time，与 `bash.ts:52` 同一源），不在构造时捕获（避免构造态/执行态不一致）。denyAll 恒 forbid 不需 platform。

**工具侧 `ctx` 可选与防 fail-open**：`Tool.execute(input, ctx?)` 的 `ctx` 入参**仍可选**（`runner.ts:28`）。对 bash/write/edit：`if (!ctx?.execPolicy) return fail("execpolicy not available")`，**一律 deny，绝不放行**。这意味着**现有 bash/write/edit 无 ctx 的测试会在 M4 后从"能跑"变"deny"**（预期行为迁移），实现清单须显式列出迁移（§7）。

**审批回调**：统一放 `execPolicy.approve`（唯一入口，消除 `ctx.approve` 与 `ctx.execPolicy.approve` 双入口矛盾）。`approve` 带超时（默认 30s），超时按**拒绝**（fail-closed），避免卡死 long-horizon。`approve` 一次只对那条命令/路径生效（带 `requestId`，多工具并发时逐一对应）。

### 4.3 AppConfig 扩展

```ts
interface AppConfig {
  // ...现有
  /** M4 execpolicy：用户预声明规则。缺省=空规则+内置危险启发式兜底（fail-closed）。 */
  readonly execRules?: ExecRule[]
  readonly dataDir: string   // 已有——rules.json 放 dataDir/projects/<hash>/ 下
  readonly onApprove?: (req: ApprovalRequest) => Promise<boolean>   // transport 挂进来
}
```

- `onApprove` 在 runtime 拼装 ExecPolicy 时注入为其 `execPolicy.approve`。
- `enableBash` 语义保留（注册≠授权）：`enableBash=false` = 工具不注册；`true` = 注册但**仍过 execpolicy**；execpolicy 是独立轴。在 `app.ts`/`index.ts`（builtin tools）注释里同步，并加测试"enableBash=true 但规则 forbid → 拒绝"。
- **注**：`app.ts:183` 当前 `toolCtx = { registry, appendAudit }`（无 execPolicy）→ `loop.ts:206` 会拿到 denyAll。**安全**（fail-closed），但主 flow 在 app.ts 尚未拼装富 ExecPolicy 前，bash/write/edit 全静默 deny——实现时**先把富策略注入排前面**（N1），避免难排查。

---

## 5. 与但管权威、DAG 的交互（防止绕过）

- **但管子会话**：spawn 出的子会话经 `runSession` 的 toolCtx 透传，继承父会话 execpolicy。但管权威管"会话间操作"，execpolicy 管"本机操作"，互不替代。`denyAllExecPolicy` 注入所有工具 ctx，但只有读它的工具（bash/write/edit）受影响，butler 工具（`butler.ts`）不读 execPolicy，不误伤。
- **DAG 节点**：当前 `dag-runner.ts:148` 的 `runSession` 只传 `sessionId/agent/resolveTool/signal`，**未传 toolCtx**（`loop.ts` 的 `RunOptions.toolCtx?` 缺省 undefined → 子会话 `ctx.execPolicy` 为 deny-all）。因此 M4 **必须**：
  - `DagDeps` 增 `toolCtx?: Omit<ToolCtx,"caller">`（或直接增 `execPolicy: ExecPolicy`）；
  - `runNode` 的 `runSession` 里透传 `toolCtx`（含 execPolicy）；
  - **`runDag` 的调用方（`app.ts`）必须提供 `execPolicy`**（继承父会话实例），此为前提（MUST-6）——否则 DAG 子会话 bash/write 全静默 deny，整条 DAG 瘫痪且难排查。`DagDeps.toolCtx` 可选仅在纯测试/无工具节点下允许。
  - 必测："DAG 子会话复用父 execPolicy 实例" 与 "DAG 子会话 bash 命中全局 forbid 被拒"。
- **Audit（复用 `audit:` 前缀 + 前缀通配）**：不新开 `"execpolicy"` AggregateType + 新查询入口。因为 `sqlite.ts:47-51` 只持久化 `aggregate_id/seq/type/data`，`aggregate` 参数被丢弃；`sqlite.ts:55` 读回硬编码 `aggregate:"session"`——`AggregateType` 只是编译期标签。真正决定"能否查到"的是 `registry.audit`（`registry.ts:90`）按 `aggregate_id` 前缀过滤。**`audit:execpolicy:<id>` ≠ `audit:<id>`**，`registry.ts:90-91` 的 `aggregateId !== \`audit:${actorSessionId}\`` 会漏；`foldAudit` 只认 `Session.ButlerAction`。所以：
  - **统一前缀为 `audit:<sessionId>`**（butler 与 execpolicy 同 aggregate），或 `app.audit` 支持 `audit:*` 前缀通配；
  - `foldAudit` 加一种分支（或新增 `foldExecAudit`），按事件类型分流 `Session.ButlerAction` 与 `Session.ExecDecision`；
  - **审计内容**：记录被 `prompt`→批准 与 `forbid` 的动作 `{ action, decision, reason, ts, requestId }`。**允许（未批准）不审计**。只审计被 prompt/forbid 的动作及其最终裁定。
  - 确保被 prompt/forbid 的动作**用户可查**（m2b 定的"拒绝也可审计"目标）。

---

## 6. 边界与不做（M4 本次裁剪）

- **不做**：Web UI（下个 milestone）、跨进程 SessionManager、持久 grant 授权（M5）、delegate-per-role 收紧（留给后续）。
- **不做**：把 read/list/search 纳入 execpolicy（只读常态，沙箱已管边界）——但须在文档**显式声明**：
  - **模型可读凭据类文件内容属可接受风险**；
  - **enableBash=true 时，模型可经 bash 读取/写入执行用户权限可达的任何文件（含 `/etc/passwd`、宿主其它工作区），此为基础残余风险**（M3.5 §2.2 已声明"不受 fs 沙箱"）；
  - **`npm install`/`pip install`/`cargo build` 等包管理器生命周期脚本可执行任意代码**——建议列为数据驱动 prompt，或至少在文档显式声明为可接受风险；
  - **`git push`/`pull`/`fetch` 的参数注入与 hook 执行**属允许型残余风险（见 §2 文档声明）；
  - **同类"跑任意内容"但未列入解释器清单的工具**（包管理器/语言运行器/数据 CLI，如 `npx`/`npm exec`/`ts-node`/`sqlite3`/`mysql`/`psql`/`Rscript`/`groovy`/`jshell` 等）在 `enableBash=true` 下解析为 `allow`（此类以 `-e`/`-c`/inline 或脚本路径执行任意代码）——**显式声明为可接受残余风险**，可通过宿主 `execRules` 加 `prefix_rule`/`network_rule` 收紧；解释器清单只枚举经典任意代码宿主（§1），不穷举全部此类工具；
  - **命名空间/伪装/提权类包装器**（`nsenter`/`unshare`/`chroot`/`proot`/`bwrap`/`firejail`/`sudo`/`su`/`doas`/`pkexec`/`setpriv`）与 `env -u VAR`（选项带参数、会遮蔽解释器）——M4 命令兜底**已列为 prompt**（放入 `EXEC_PREFIX_WORDS`/危险启发式，使扫描能穿透包装器找到其后的 shell/解释器）；若宿主希望放宽某个沙箱工具（如确属本机隔离的 `bwrap`/`proot` 只读用途），可在 `execRules` 加 `prefix_rule` 显式 allow（缺省仍严）；
  - 这些与 ADV-2/ADV-3 并列，避免被误读为"漏审"。
  - `read` 仍单列拒绝 `.newhorse/rules.json`。写入不作内容审查（M4 命令兜底 + 拆包缺省严两条补上后，"写完脚本→bash 跑"才真正被兜住）。
- **不做**：执行前沙箱（真进程隔离待 OS 层，M4 只做授权裁决不引入容器/VM）。
- **性能注意**：多工具并发（`loop.ts` `Promise.allSettled`）时多个 prompt 审批并行弹出——`approve` 带 `requestId`，一次审批只对那条命令生效。

---

## 7. 实现前置清单（统一）

- [ ] `schema/` 增 `ExecPolicy`/`ExecRule`/`Decision`/`ApprovalRequest` 类型（纯类型，无依赖）。
- [ ] `core/` 增 `denyAllExecPolicy`（deny-all：decide/decidePath 恒 forbid）——仅依赖 schema 类型。
- [ ] `core/src/agent/runner.ts` `ToolCtx.execPolicy?` 增；`loop.ts:206` 装配处 `execPolicy: opts.toolCtx?.execPolicy ?? denyAllExecPolicy`（放在 `...opts.toolCtx` spread 之后）。
- [ ] `runtime/src/tools/execpolicy.ts`：规则引擎（decide/decidePath/最长前缀优先取max/跨平台危险表（win32=COMMON∪WIN_SPECIFIC）/恒为底线/shell拆包+引号感知tokenizer（win32+posix）/解释器清单+脚本执行+内联+控制源特判/自举写回+凭据排除+BANNED_PREFIX+BANNED_RULES_PATH（路径引用探测）/原子写+版本快照）。**全部数据驱动，无 if/else 链**。
- [ ] `shell_wrapper` 引号感知 tokenizer 伪码（**platform 参数，win32+posix 分支**）：
  - **posix**：单/双引号内不做分隔切分；`$(…)`/`` `…` ``/`$…`/`${…}`/反斜杠转义/`eval`/`source`/`.`/`xargs`/嵌套 `sh -c`/`bash -c` 命中（或 `bash -lc`/`bash -l` login shell）→ 标"不可完全解析→倾向拒绝"。
  - **win32（cmd /c）**：识别 `&`/`&&`/`||`/`|` 分隔、`^`（尤其跨行续行）、`%VAR%`/`!VAR!`（delayed expansion）、`()` 复合、`<`/`>` 重定向；凡含 `%…%`/`!…!` 或 `^`+换行 → 标"不可完全解析→倾向拒绝"。
- [ ] `bash.ts` 改签名 `(input, ctx?)` + 调 `ctx.execPolicy.decide` + `ctx.execPolicy.approve?`（超时 fail-closed）+ 按 `process.platform`（call-time）选危险表 + 无 execpolicy 即拒绝；`write.ts`/`edit.ts` 改签名 `(input, ctx?)` + 调 `decidePath`（含路径归一 + `.newhorse/**` 双保险） + 无 execpolicy 即拒绝。`read.ts` 拒绝 `.newhorse/rules.json`。
- [ ] `app.ts` 拼装富 ExecPolicy（规则加载自 dataDir + onApprove 注入 approve + dataDir 传给 rules.json 读写 + git 读操作 allow 规则默认集 + **富策略注入排在主 flow 前**）+ 审计落 `audit:<sessionId>` 下的 `Session.ExecDecision`；`dag-runner.ts` `DagDeps.toolCtx?` + `runSession` 透传 toolCtx（含 execPolicy）+ `runDag` 调用方必带 execPolicy。
- [ ] **迁移现有 bash/write/edit 无 ctx 测试**（MUST-5）：显式传 allow 的 ctx 或改断言为 deny。`tools.test.ts` 现有无 ctx 调用在 M4 后由"能跑"变"deny"；read/list/search 不受影响。
- [ ] `registry.ts` `foldAudit` 增 `Session.ExecDecision` 折叠分支 + `audit:` 前缀通配。
- [ ] 测试：规则取最严（最长前缀优先）、壳拆包防绕过、`bash -c` 嵌套引号/命令替换/`eval`/`source`/`xargs`、win32 高危（`del /f /s /q`/`format`/`reg delete`/`icacls`/`taskkill /f`/`powershell -enc`/`pwsh`/`cscript`/`regsvr32`）、`cmd /c "echo a & powershell -enc ..."`、`%COMSPEC%` 变量注入 → prompt/forbid、敏感路径 prompt、脚本文件执行特判（`python x.py`/`cscript x.vbs`）、内联特判（`python -c`/`node -e`）、**decidePath 路径归一（`.newhorse/rules.json`/`./.newhorse/rules.json`/`\.newhorse\rules.json`/绝对路径全 forbid，B2）**、无交互 fail-closed、自举写回+凭据排除+BANNED_PREFIX、bash 写规则文件→forbid、DAG 继承、`.newhorse/rules.json` write/read 双拒绝、enableBash=true 但 forbid→拒绝、**启发式恒为底线（规则 allow 不升格危险）**、`git push`=allow 且 `git log`=prompt（前缀语义）、**`powershell -enc` 显式 forbid（B1）**。

---

## 8. 必测场景（实现后）

1. **危险命令被拦**：非交互会话，模型想跑 `rm -f x`（posix）/ `del /f /s /q`（win32）→ 命中启发式 → 无审批回调 → fail-closed 返回 `{ denied, reason }`。
2. **敏感路径被问**：交互会话，模型想 `write` 一个 `.env` → 命中 path_rule prompt → CLI 提问 → 用户批准 → 执行，**但不自举写回（凭据类排除）**；若写 `.ps1` → 批准后可写回（`path_rule ["**/.env"]=allow` 命中时 `.env` 仍 prompt，启发式恒为底线）。
3. **shell 包装不绕过**：`bash -c "git push && rm -f x"` → 拆包后 `rm -f` 命中启发式 → 整条 `forbid`。`bash -c "eval 'rm -f /tmp/y'"` → `eval` 命中控制源 → 倾向拒绝。win32 `cmd /c "echo a & powershell -enc ..."` → `&` 拆包 → `powershell -enc` 命中危险表 → forbid（B1）。
4. **规则文件投毒被拒**：模型 `write .newhorse/rules.json` → `.newhorse/**` 恒 forbid（路径归一后仍 forbid，B2）；`bash echo '...' > dataDir/.../rules.json` → `BANNED_RULES_PATH` forbid。模型无法自授权、也读不到边界。
5. **内联代码绕不过**：模型 `bash python -c "...os.system('rm -rf x')..."` → 解释器+`-c` 命中内联特判 → prompt（无交互 → forbid）。`bash powershell -EncodedCommand "..."` → 命中 win32 危险表 → forbid（B1）。`bash cscript x.vbs` → 解释器清单命中脚本执行特判 → prompt。
6. **启发式恒为底线**：即使一条 `["rm","-rf"]=allow` 规则命中，`rm -f` 仍被启发式禁止。
7. **DAG 继承**：DAG 子会话复用父 execPolicy 实例；`git push` 在 DAG 子会话命中 `["git","push"]=allow` → allow；`git log` → `["git"]=prompt` → 无交互 forbid（或按 git 读操作 allow 规则放行）。
8. **win32 平台**：`del /f /s /q`/`format`/`reg delete`/`powershell -enc`/`pwsh -c` 在 win32 上命中危险表 → prompt/forbid；`cmd /c` 的 `%VAR%`/`^`/`&` 注入命中"不可完全解析" → 倾向拒绝。

---

## 9. 已敲定的开放点（四轮锐评裁决）

- **凭据类（.env/.pem）批准后写回？** —— **绝不写回**，硬性逻辑（`CREDENTIAL_SUFFIX` 命中则跳过自举）。
- **git push 放行 but curl 拦截？** —— 最长前缀优先 + 显式规则：`["git","push"]=allow` 覆盖 `["git"]=prompt`；git 读操作显式 allow 或归普通命令；`curl`/`wget` 未知 host=forbid；明确 `network_rule` 挂载点。
- **enableBash 与 execpolicy 分层？** —— "注册≠授权"：未注册（false）/ 注册且需过轴（true）/ 轴独立裁决。文档 + 注释 + 必测。
- **execPolicy 注入点归属 + core 缺省？** —— core 拥有 deny-all 缺省（安全兜死），runtime 经 toolCtx 覆盖注入富策略；`ToolCtx.execPolicy` 定为可选，loop 兜底填充。
- **审计 aggregate 取舍？** —— 复用 `audit:<sessionId>` 前缀 + `Session.ExecDecision` 事件 + 前缀通配 + fold 分流，不新开 AggregateType + 新查询入口。
- **是否执行前沙箱？** —— 不做（§6），M4 只做授权裁决。
- **win32 平台拆包 + 危险表？** —— 按 `process.platform`（call-time）分支；win32 数组 = posix ∪ win32 特有（B1 MUST）。
- **`git -c` 全局 option？** —— 不跳过（安全 fail-closed），文档标注（S2）。
- **路径归一？** —— `decidePath` 收原始路径并归一（大小写折叠 + `\`→`/` + 剥前导 `./` + 绝对路径相对化），`.newhorse/**` 段落兜底 + resolve 后绝对路径双保险（B2）。

---

## 10. 独立锐评要求

四轮锐评已识别并修正首轮 M1–M5、二轮 MUST-1–6/ADV-1、三轮 M1/M2 + A1/A2/A3、四轮 B1/B2 + S1/S2/S3；本第五修正稿**必须复评清零后**才允许实现。复评重点（对准本轮 must-fix）：
- **B1（win32 任意代码向量）**：`powershell -enc`/`pwsh`/`cscript`/`wscript`/`regsvr32`/`mshta` 是否入危险表 + 解释器清单；`BANNED_PREFIX` 是否补；win32 数组是否 = posix ∪ win32 特有；§8 必测 3/8 是否可达标（`powershell -enc` 显式 forbid 断言）。
- **B2（decidePath 归一）**：`.newhorse/**` 恒 forbid 是否经路径归一后仍闭合（相对/`./`/反斜杠/绝对路径全 forbid）；`write`/`edit` 是否共用 `decidePath`。
- **S1（platform call-time）**：`decide` 是否 call-time 读 `process.platform`（与 bash.ts:52 同一源），避免构造态/执行态不一致。
- **S2（git -c 不跳过）**：是否有意 fail-closed，未放大 G2 残留风险。
- **S3（BANNED_RULES_PATH 路径引用探测）**：不分写/删/改；`Remove-Item`/`del`/`rmdir` 作用于 rules 目录是否 forbid。
- 其余：R1 审批入口统一、R6 数据驱动无 if/else、R7 approve 超时 fail-closed、ADV-4 decide 纯函数 + 版本快照、G1 butler 不误伤、G3 依赖无违例、N2 spread 顺序。
- **必须复评 findings 清零后才允许实现。**

---

## 11. 实现前说明（对 AGENTS.md 红线的自我核对）

| 红线 | 本设计如何满足 |
|---|---|
| no scattered branches | 规则原语 + 危险启发式（COMMON/WIN_SPECIFIC/win32/posix 数组）全数据驱动；decide/decidePath 为纯函数取 max，无 per-op if/switch。 |
| design-first | 本 spec 先于实现，状态明确"复评清零后才实现"。 |
| review before done | §10 要求复评清零；实现后再委派实现后独立复评（对照代码）。 |
| core 不 import 上层 | `ExecPolicy`/`ExecRule`/`ApprovalRequest`/`Decision` 放 `schema`（纯类型包）；`denyAllExecPolicy` 放 core（仅依赖 schema）；规则引擎放 `runtime/src/tools/execpolicy.ts`. `ToolCtx.execPolicy` 是 core `agent/runner.ts` 契约——runtime 注入实现。core 只 import `@newhorse/schema`，无上层反向依赖。 |
| 模型无关（#4） | execpolicy 是宿主态规则，与 LLM 品牌无关，未引入 provider 泄漏。 |

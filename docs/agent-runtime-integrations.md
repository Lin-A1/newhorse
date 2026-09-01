# agent-runtime 接入波:六个机制的设计决策

> 2026-09-01。回答"agent-runtime 还能接入什么"的落地波:六个机制,全部顺着现有 seam 走,不改骨架契约(seam 三段式 / LLM 词汇 / 事件溯源形态 / 依赖方向)。每节:决策、不变量、显式不做。

## 1. MCP client seam(工具生态的标准接入口)

**决策**:`packages/mcp` 新包,零框架依赖(手写 JSON-RPC 2.0 客户端,~250 行)。`createMcpTools(configs): Promise<{ tools: Tool[]; dispose(): Promise<void> }>`——对每个配置的 server 建立连接,`tools/list` 映射为 `Tool[]`(命名 `mcp__<server>__<tool>`,沿用 CC 约定),`execute` 走 `tools/call`,content 数组拼 text,isError → throw。传输两种:`stdio`(子进程,行分隔 JSON-RPC)与 `http`(streamable:POST JSON-RPC,Accept 同时带 json 与 text/event-stream,两种响应都会解析)。

**接线**:配置在 AgentHomeConfig `mcpServers: Record<name, {command?, args?, env?, url?, headers?, enabled?, allowedTools?}>`;main.ts 启动时解析为工具,经 `AppConfig.tools` 传入(explicit 工具与本内/插件工具是**相加**关系,首个同名占位——与现有优先级规则一致)。`sideEffects: true`(保守;工具真实副作用未知)。`allowedTools` 过滤在适配层做,不进 execpolicy。

**不变量**:连接失败 = 该 server 的工具整体缺席 + stderr 告警,**绝不阻塞会话创建**(外部依赖 fail-soft)。dispose 在宿主停机时调用。

**显式不做**:resources/list、prompts、sampling;SSE 长连接回退(streamable POST 足够);OAuth 授权流。

## 2. 模型能力目录(capability catalog)

**决策**:`packages/runtime/src/catalog.ts`。目录文件 `<agentHome>/model-catalog.json`,`{ schemaVersion: 1, providers: [{ id, name?, endpoints?: { baseURL, paths?: Record<kind, string> }, defaultKind?, models: [{ id, name?, kinds?: string[], modalities?, contextWindowTokens?, maxOutputTokens?, reasoning? }] }]}`——字段语义对齐 ZCode 目录(schemaVersion 24 的简化),reasoning 保持 opaque(原样透传给设置页)。加载器最小校验(id 非空、models 数组),坏文件 = null + stderr 告警(fail-soft)。端点 `GET /v1/models/catalog` 返回 `{ catalog }`。示例文件 `examples/model-catalog.json` 入库。

**不变量**:目录是**参考数据**,不参与路由决策——provider/model 仍以 AgentHomeConfig 为准;目录缺失时端点返回 `{ catalog: null }`,UI 降级为手填。

**显式不做**:目录热更新/远端拉取;目录驱动的自动建预设。

## 3. `/v1/file` 文件内容读取端点

**决策**:`GET /v1/file?workspace=&path=`,复用 `/v1/fs` 的沙盒判定(resolve 后必须落在 workspace 根内)。响应 `{ path, size, encoding: "utf8" | "base64", content, truncated? }`:≤2MB 且前 8KB 无 NUL 字节 → utf8 全文;否则 base64;超 2MB → 截断前 2MB 并标 `truncated: true`。目录/不存在 → 403/404。

**不变量**:只读;词法逃逸与符号链接都挡(`resolve` 前缀判 + `realpath` 复判)。`workspace` 参数沿用 `/v1/fs` 语义(调用方指定根;token/回环门是外层防护)——不做注册工作区白名单。
**快照 vs 事件**:`/v1/session/:id` 快照里新流程的用户消息带 refs(不注水字节);需要图像形状的渲染走 `/events`(已注水回 `images`)。

## 4. model-io 调用轨迹(`Session.ModelCalled`)

**决策**:`RunOptions.onModelCall?: (info: ModelCallInfo) => Promise<void> | void`,`runTurn` 在流结束后调用(含 `model、source、durationMs、finish、usage、promptChars、outputChars、toolCalls、error?`)。runtime app 接线为追加 `Session.ModelCalled` 事件(source: "turn");compaction 摘要以 source "compaction" 追加。memory 提取是管线内部调用,v1 不落轨迹(source "extraction" 预留)。轨迹进事件日志 → `/v1/session/:id/events` 与 usage 聚合自然可见,零新端点。

**不变量**:轨迹 append 失败**不吞回合**——与 StepEnded 同层传播(store 坏则整体坏,不假装成功;compaction 轨迹同此);不落请求/响应正文(体积与隐私),只落计数与元数据;`promptChars` 只累计文本字段长度,绝不序列化图像 base64。

**显式不做**:per-call 正文落盘(ZCode 的 model-io 是调试器级需求,放产品层)。

## 5. 图像附件管线 wave 1(内容寻址 + 预算闸门)

**决策**:核心新增 `packages/core/src/attachments.ts`:`createAttachmentStore(rootDir)`——`put(bytes, mime) → { sha256, bytes }`(内容寻址 `<root>/ab/<sha256...>`,已存在即跳过写入=天然去重)、`get(sha) → bytes|null`。`TurnRuntime` 增加可选 `attachments`。admit 路径:prompt 图像先入 store,**新事件携带 `attachments: [{ sha256, mime, bytes }]`(引用+字节数)而非内联 base64**;`Prompted` 重放同形。lowering(messages.ts)遇到引用 → 从 store 取字节 → 现有 image part(老事件的内联 `images` 原样兼容)。服务端 `/events` 对带引用的事件**注水回 `images` 形状**返回(客户端契约不变,日志与字节解耦)。

**预算闸门(admit 时,确定性)**:单图 ≤ 20MiB 原始字节;单请求图数沿用 ≤5;总原始字节 ≤ 25MiB。注意两套闸门的层级:HTTP 传输闸门更紧(单图 4M base64 字符 ≈ 3MB、≤5 张、40MB body)会先触发——走 HTTP 的客户端永远先撞传输闸门;**引擎闸门的确定性剔除是 embedder/SDK 直连面的行为**。超总预算时**按位置从最老开始整张剔除**(同样输入永远剔同样几张)——与 dsh 的 quantum 剔除同思路;被剔的图以 `[image N omitted: over budget]` 占位进 prompt 文本。

**不变量**:store 写入不可变(同 sha 覆盖写是幂等 no-op);v1 不做 GC(对象库只增——审计优先);不做转码/降采样(无图像编解码器,编码器是未来插件 seam;客户端纪律在 handoff §5.5 已钉)。

**显式不做**:投影缓存与 pixelBudget(等编码器 seam);store GC;跨会话上传索引。

## 6. 入站渠道 seam(webhook 先行)

**决策**:`packages/runtime/src/channel.ts` + 服务端路由。配置 `channels: [{ id, sessionId?, webhookUrl?, secret?, enabled? }]`(AgentHomeConfig)。入站:`POST /v1/channel/:id/inbound {text, userId?}` → 解析渠道绑定的会话(显式 sessionId 或 `stableSessionId("channel:"+id)` 的常驻会话),以 principal "user" **走既有 prompt 全链路**(durable admission → SSE 语义同源),同步等待回合结束,返回 `{ sessionId, finish, text }`。出站:回合结算后,若配 `webhookUrl`,POST `{ channelId, sessionId, prompt, reply, finish }`,头 `X-Newhorse-Signature: sha256=<hmac(secret, body)>`,5s 超时、失败仅 stderr(渠道是旁路,绝不倒灌主链路)。

**不变量**:渠道消息与人工消息走**同一条 admission 通道**(幂等、可重放)——渠道不是第二条特权路径;secret 缺失 = 不签名但不拒绝出站(入站无鉴权字段,绑定是操作者信任决策)。v1 入站是**同步等待**:回合超过 idleTimeout(默认 120s)时入站连接会断,但回合与 webhook 仍完成——渠道调用方必须容忍;同一会话重入(如 webhook 重投)返回错误,调用方重试。

**显式不做**:IM 平台原生协议(飞书/Telegram 的 WebSocket/长轮询)、绑定码流、多用户会话隔离(v1 一个渠道一个会话)。

## 落地顺序与验收

3 → 4 → 2 → 1 → 5 → 6(小→大)。每个机制:实现 + 包内测试 + `bun typecheck` 通过;全量后独立评审 must-fix 清零。镜像同步(`scripts/sync-agent-runtime.ts`)在合入后执行。

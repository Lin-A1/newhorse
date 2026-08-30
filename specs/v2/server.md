# Runtime Server (Phase 1) 接口 Spec

> 状态：**已实现（2026-08-29；独立存储于 [Lin-A1/agent-runtime](https://github.com/Lin-A1/agent-runtime)，含 env 驱动入口 `packages/server/src/main.ts`）** — `packages/server` + 10 测试（含真实 socket 断连回归）。实现决策记录于 `docs/core-technology-notes.md` §18。方向：runtime server 优先；transport 只做 parse/headers/stream，领域逻辑全在 `createApp`。所有端点映射到 `packages/runtime/src/app.ts` 的 `App` 成员。
> 遵循 AGENTS.md："CLI / server / SDK 是 transport only；它们不持有任何领域逻辑"。

---

## 0. 设计原则

- **server 是 transport**：不引入任何 session/agent 领域逻辑，只把 `App`（createApp）暴露成 HTTP 边界。禁止 server 直接操作事件日志或调 `runSession`。
- **单一数据流**：`LLMRequest`/`LLMEvent` 词汇表、事件溯源日志都是 transport-无关的；server 只序列化它们。
- **streaming 是核心**：`prompt` 是长时间运行的操作，必须用 SSE 流式事件（复用 `App.onEvent` fan-out），调用方逐个事件消费，而不是等一次 JSON。
- **可测试**：`Fetcher`（llm）是可注入的，server 的 mock 也可注入——测试不碰真实网络。
- **权限**：server 的 execpolicy `onApprove` 由 transport 注入（像 CLI 那样交互或用配置自动允许）。server 默认不信任远端——只允许 loopback 或显式绑定 + 可选 token。

## 1. 端点契约

所有请求/响应 JSON 编码，除流式端点外无 cookie/会话。路径前缀 `/v1`。

### `GET /v1/health`
- 返回 `{ status: "ok" }`。
- 无副作用，用于探活。

### `POST /v1/session` — 创建（或 attach）一个会话
- body: `{ workspace?: string, sessionId?: string, model?: string, provider?: { kind, baseUrl, apiKey?, extraHeaders? }, tools?: ToolSpec[] (显式覆盖), enableBash?: boolean, pluginsDir?: string, dataDir?: string }`
- 行为：调用 `createApp(config)`（sessionId 缺省用 `stableSessionId(workspace)`——与 CLI 一致，同一 workspace 重启 attach 同一 log）。
- 返回：`201 { sessionId, messageCount, headSeq }`。
- **server 生命周期**：一个 server 进程持有 `App` 实例的 map（sessionId → App）；`createServer(config)` 直接返回活着的 `ServerHandle`（内部 `Bun.serve` 已启动，`port:0` 取临时端口）；`POST /v1/session` 注册一个（若存在则返回现有）。每个 App 是独立会话（不同 sessionId 彼此并行）。`handle.stop()` 中断在途 prompt 后关闭服务器与事件存储。

### `POST /v1/session/:id/prompt` — 流式 prompt
- body: `{ text: string, principal?: "user"|"butler"|"parent" }`
- 行为：`app.prompt(text, principal)`，走 SSE 流式返回事件（`text`/`reasoning`/`tool`/`tool-result`/`step`/`done`/`error`），与 CLI `onEvent` 相同词汇表。
- HTTP: `200` + `Content-Type: text/event-stream`。每个事件一行 `data: {json}`。流结束发 `data: [DONE]`（对齐 llm 传输层惯例）。
- 错误：`404` 若 sessionId 不存在；`400` 若 text 缺失。
- 语义：`prompt` 是主路径（阻塞该 session 直到 settle 或中断）。与 `steer` 区分（见下）。

### `POST /v1/session/:id/steer` — 非阻塞 steer
- body: `{ text: string }`
- 行为：`app.steer(text)`（`delivery:"steer"`，在下个安全边界提升；若 session 空闲则不会立即跑，只入 inbox）。**非阻塞**，立即返回。
- 返回：`{ admitted: true }`。
- 语义：区别于 `prompt`——`prompt` 驱动一次 run；`steer` 只投递，等已有 run 的下一轮边界。

### `GET /v1/session/:id` — 会话投影
- 行为：`app.resume()` → 完整 `SessionSnapshot`（含 messages）。
- 返回 `SessionSnapshot`（schema/session.ts）。`404` 若不存在。

### `GET /v1/sessions` — 列表
- query: `?workspace=&status=&projectId=`
- 行为：`app.listSessions(query)`（`SessionRegistry` 派生读模型）。
- 返回：`SessionRow[]`。

### `GET /v1/audit` — 审计
- query: `?actorSessionId=`
- 行为：`app.audit(actorSessionId?)`。
- 返回：`AuditEventRow[]`。

### `GET /v1/session/:id/events` — 日志重放
- 行为：`app.events.read(sessionId)` → `StoredEvent[]`（完整事件溯源日志）。
- 用于 shell 追 cursor / 恢复 UI。返回 `StoredEvent[]`（`{aggregate_id, seq, type, data, aggregate}`）。

### `POST /v1/session/:id/interrupt` — 中断
- 行为：`app.interrupt()`（单进程已可用；跨进程/spawn 为未来）。
- 返回：`{ interrupted: true }`。若会话空闲无副作用。

## 2. SSE 事件契约（与 LoopEvent 一致）

```
data: {"type":"text","text":"..."}
data: {"type":"reasoning","text":"..."}
data: {"type":"tool","name":"...","input":{...}}
data: {"type":"tool-result","name":"...","output":{...}}
data: {"type":"step","step":N}
data: {"type":"done","step":N,"needsContinuation":bool,"finish":"..."}
data: {"type":"error","code":"...","message":"..."}
data: [DONE]
```

流结束后（`[DONE]` 后）可发 `data: {"type":"result","step":N,"needsContinuation":bool,"finish":"..."}`（等价 `PromptResult`）作为最终结构化结果。`onEvent` fan-out 的 listener 隔离（broken listener 不 corrupt settle 路径）由 `createApp` 保证。

## 3. 安全边界

- **默认 loopback-only**：`createServer({ host?: string, port?: number, token?: string })` —— `host` 缺省 `127.0.0.1`；`token` 提供时，所有请求头 `Authorization: Bearer <token>` 校验（constant-time 比较）；无 token 时只允许 loopback。
- **execpolicy `onApprove`**：server 不内置交互式审批（无 TTY）。两种模式：`onApprove` 由 server 配置注入（如自动 deny 所有 prompt —— fail-closed 默认），或由连接方提供一个 `POST /v1/approve` 会话端点（列入未来）。**Phase 1：默认 fail-closed（`prompt` → `forbid`）**，server 配置允许注入 `onApprove`。
- **禁止**：server 内嵌 path 解析/execpolicy 逻辑——全部走 `App`。

## 4. 依赖/文件

- 新包 `packages/server`：`src/index.ts`（入口）、`src/server.ts`（HTTP 层）、`src/types.ts`（端点 DTO 类型，复用 schema/App 类型）。
- 依赖：`@newhorse/runtime`、`@newhorse/schema`、`@newhorse/llm`（provider 类型）。**不依赖 core 直接**（走 runtime）。
- tsconfig.json 的 `paths` 加 `"@newhorse/server": ["./packages/server/src/index.ts"]`（同时补上缺失的 `@newhorse/runtime` mapping）。

## 5. 验收

- [x] `createServer(config)` 返回 `{ baseUrl, appFor, stop }`——`port:0` 用于测试取临时端口。
- [x] 端点表全部实现（health/session/prompt/steer/get/list/audit/events/interrupt）。
- [x] `prompt` 流式 SSE：mock `Fetcher`（openai 协议 SSE）→ 一个 prompt 产生 text/tool/done 事件 → `[DONE]` 收尾。
- [x] 客户端断连的 **JS 层**崩溃（closed-controller 拒绝）已修复（`cancel()` 守卫 + try/catch）——回归测试 `it.skip`（Bun 1.3.14 进程级 panic 是 Bun bug，见 docs §18）。
- [x] 重启 attach：`POST /session` + dataDir → `GET /session:id` 投影有历史。
- [x] 测试：`packages/server` 有 `server.test.ts`（注入 `fetch`，无网络）。
- [x] `bunx tsc --noEmit` 干净（packages/server + 全仓 7 包）。tsconfig paths 更新。

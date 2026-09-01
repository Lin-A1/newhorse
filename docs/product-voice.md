# 产品声音（Voice & Identity）

> 本文记录已拍板的产品决策（定位、命名、配色），改动前先读。引擎键名（`role: "butler"`、`asButler` 等）是持久化标识符，**不改**；UI 一律使用下述产品名。

## 1. 常驻会话就叫 newhorse（引擎键：butler）

**定位**：newhorse 会话是产品的**常驻主会话**——读文件、跑工具、把大任务拆给子代理并行推进、汇总结果。它是产品的默认体验（新建会话默认带调度工具集）；"普通模式"是显式关闭调度后的轻量形态。

**命名决策（两轮迭代）**：第一版「管家」太仆人味；第二版「头马」是硬造人设，尴尬。结论：**不造人设名——产品本身就是名字**。opencode/codex 的主会话也没有花名。

**呈现规则**：
- UI 文案一律「newhorse 会话」；徽章用**迷你情绪球**做头像（球只在此处与应用 logo 出现，不作为装饰散布）。
- 引擎人格正文（`runtime/context.ts` BUTLER_BODY）无自造名号，直接以 newhorse 自称并陈述职责。
- 事件/schema 键 `role: "butler"`、传输参数 `asButler` 保持不变（持久化兼容）。

## 2. 配色 = opencode oc-2 实际值（从源码提取，不自造）

用户明确反馈：拒绝天蓝、拒绝自造"蜜桃"，要 opencode 一样的配色。以下取自 `opencode/packages/ui/src/theme/themes/oc-2.json`：

| 角色 | 暗色（默认） | 浅色 | oc-2 出处 |
|---|---|---|---|
| 背景 | `#161616`（grey-1100） | `#f7f7f7` | grey-1100 / light bg |
| 最深层（chrome） | `#080808`（grey-1200） | — | grey-1200 |
| 面板 | `#1c1c1c`（surface-base） | — | surface-base |
| 边框 | `#282828` / 强 `#3a3a3a` | — | border-weak-base / grey-800 |
| 正文 | `#ededed`（strong）/ `#a0a0a0`（base）/ `#707070`（weak） | 深灰墨 | text-strong/base/weak |
| 交互（按钮/链接/选中） | `#034cff` interactive | 同 | palette.interactive |
| 品牌标记（头像/身份点缀） | `#fab283` primary | `#dcde8d` primary | palette.primary |

- 语义：**蓝=可交互**，**蜜桃/淡绿=品牌与身份**，灰阶=一切结构。不再自造色。
- 克制原则：按钮纯色无渐变无辉光；无装饰性动画；点阵背景已移除。

## 3. 禁止事项

- **禁止 emoji**（情绪球是唯一"脸"，且只作头像/logo）。
- 禁止把引擎键名（butler/dag 等）直接暴露成 UI 文案。
- 禁止自造人设名（管家/头马均已被否）。

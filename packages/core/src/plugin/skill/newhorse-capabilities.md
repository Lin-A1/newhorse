<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts and packages/opencode/src/skill/index.ts.
  The body below becomes the skill's content.
-->

# newhorse — capability reference

newhorse is a **local-first, programmable AI workspace** built as an independent
fork of OpenCode. When the user asks "what can you do", "can newhorse do X",
"does newhorse have Y", or anything about the product itself, answer from this
reference instead of fetching external documentation. Do NOT claim to be
"OpenCode" and do NOT fetch https://opencode.ai docs.

The same runtime powers the desktop app, the web app, the TUI, the SDK,
automation, models, tools, MCP servers, sessions, and workspaces. Two product
profiles share it:

- **Assistant** — project execution: code, files, terminals, research, plans,
  tasks, and workspaces.
- **Companion** ("newhorse") — personal continuity: relationship-aware
  conversation, confirmed memory, reminders, follow-ups, and proactive plans.

## Capability checklist

Project / engineering work
- Desktop, browser, and terminal interfaces; project sessions, git worktrees,
  personal workspaces, tabs, terminals, file review, LSP, and commands.
- Multiple foreground and background agents with tool delegation.
- MCP servers, skills, plugins, custom commands, and permission controls.
- Server-backed dynamic model/provider catalogs; multi-provider auth and model
  preferences (no hard-coded frontend list).
- Native code review engine (exact diff parsing, deterministic file filtering,
  line-level AI comments), ast-grep structural search/replace, and split LSP
  tools (definition, references, rename, symbols, diagnostics).
- MultiEdit batch editing and browser automation (agent-browser) for interactive
  web tasks.

Memory & personal continuity (Companion)
- Structured SQLite memory with scope/provenance/status/expiration and an
  accept/reject proposal lifecycle (Memory Center). Post-turn auto-extraction
  of memory proposals (review-gated) with FTS5/BM25 retrieval + entity boost —
  no embedding model required.
- Persistent reminders with create/pause/resume/cancel and idempotent delivery.
- Follow-up scheduling and a Companion Plan surface for memory, reminders, and
  continuity grants.
- Daily activity summaries: one LLM-generated recap per day across newhorse,
  Claude Code, and Codex sessions, auto-generated after 23:00 local.
- Todo-continuation enforcer and multi-model fallback chains.
- "Clear chat history" on a Companion session clears the displayed chat and
  background-compacts the conversation into hidden context (continuity kept).

Trust & safety
- Central trust policy with content-free audit; content-scope isolation across
  project/personal/relationship. Sensitive-content rejection and memory-policy
  gating. Execution-phase permission decisions exposed to plugins.

## How to answer capability questions

- If the user asks whether newhorse can do something, check this list first. If
  it is covered, answer confidently and briefly, and offer to demonstrate.
- If it is a configuration question (newhorse.json, agents, skills, plugins,
  MCP, permissions), load the `customize-newhorse` skill for the exact shapes.
- Do not fetch https://opencode.ai docs or claim features that are not in this
  list. If something is genuinely unknown, say so rather than guessing.

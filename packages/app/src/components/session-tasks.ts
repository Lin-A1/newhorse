import type { Part, SessionStatus } from "@newhorse/sdk/v2/client"

export type SessionTaskState = "running" | "completed" | "error"

export type SessionTask = {
  id: string
  title: string
  agent?: string
  background: boolean
  state: SessionTaskState
  startedAt: number
  summary?: string
}

type TaskBlock = { id: string; state: SessionTaskState; inner: string }

const TASK_BLOCK = /<task\b([^>]*)>([\s\S]*?)<\/task>/g
const ATTR_ID = /\bid="([^"]+)"/
const ATTR_STATE = /\bstate="(running|completed|error)"/
const TASK_SUMMARY = /<summary>\s*([\s\S]*?)\s*<\/summary>/

export function parseTaskBlocks(text: string): TaskBlock[] {
  const blocks: TaskBlock[] = []
  for (const match of text.matchAll(TASK_BLOCK)) {
    const id = match[1].match(ATTR_ID)?.[1]
    const state = match[1].match(ATTR_STATE)?.[1] as SessionTaskState | undefined
    if (!id || !state) continue
    blocks.push({ id, state, inner: match[2] })
  }
  return blocks
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function applyBlock(task: SessionTask, block: TaskBlock, summary: string | undefined) {
  task.state = block.state
  if (summary) task.summary = summary
}

function summaryOf(text: string): string | undefined {
  return text.match(TASK_SUMMARY)?.[1]?.trim() || undefined
}

/**
 * Derives the subagent (task tool) lifecycle of a session from its own durable
 * parts. Launch markers are task tool parts carrying the child session id in
 * their state metadata; background results are injected as synthetic text
 * parts holding a `<task state="completed|error">` block. There is no other
 * durable channel for task status, so live `session.status` events only refine
 * tasks that have no terminal marker yet.
 */
export function deriveSessionTasks(input: {
  messages: readonly { id: string }[]
  parts: (messageID: string) => readonly Part[] | undefined
  status: (sessionID: string) => SessionStatus | undefined
}): SessionTask[] {
  const byID = new Map<string, SessionTask>()
  const terminal = new Set<string>()

  const upsert = (id: string): SessionTask => {
    const existing = byID.get(id)
    if (existing) return existing
    const task: SessionTask = { id, title: id, background: false, state: "running", startedAt: 0 }
    byID.set(id, task)
    return task
  }

  for (const message of input.messages) {
    for (const part of input.parts(message.id) ?? []) {
      if (part.type === "tool" && part.tool === "task") {
        const state = part.state
        const metadata = "metadata" in state && state.metadata ? state.metadata : undefined
        const childID = readString(metadata?.sessionId)
        if (!childID) continue
        const task = upsert(childID)
        task.title = readString(state.input?.description) ?? task.title
        task.agent = readString(state.input?.subagent_type) ?? task.agent
        task.background = task.background || metadata?.background === true || typeof metadata?.jobId === "string"
        const start = readNumber("time" in state ? state.time?.start : undefined)
        if (start !== undefined && (task.startedAt === 0 || start < task.startedAt)) task.startedAt = start
        if (state.status === "completed" || state.status === "error") {
          const text = state.status === "completed" ? state.output : state.error
          const block = parseTaskBlocks(text)[0]
          if (block) {
            applyBlock(task, block, summaryOf(block.inner))
            if (block.state !== "running") terminal.add(childID)
          } else {
            task.state = state.status
            terminal.add(childID)
          }
        }
      } else if (part.type === "text" && typeof part.text === "string") {
        for (const block of parseTaskBlocks(part.text)) {
          const task = upsert(block.id)
          applyBlock(task, block, summaryOf(block.inner))
          if (block.state !== "running") terminal.add(block.id)
        }
      }
    }
  }

  for (const task of byID.values()) {
    if (terminal.has(task.id)) continue
    const status = input.status(task.id)
    if (status && status.type !== "idle") task.state = "running"
  }

  return [...byID.values()].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))
}
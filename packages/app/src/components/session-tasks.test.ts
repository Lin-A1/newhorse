import { describe, expect, test } from "bun:test"
import type { Part, SessionStatus } from "@newhorse/sdk/v2/client"
import { deriveSessionTasks, parseTaskBlocks } from "./session-tasks"

const tool = (partial: Partial<Extract<Part, { type: "tool" }>>) => ({
  id: "part-1",
  sessionID: "parent",
  messageID: "msg-1",
  type: "tool" as const,
  callID: "call-1",
  tool: "task",
  state: {
    status: "completed" as const,
    input: {},
    output: "",
    title: "task",
    metadata: {},
    time: { start: 0, end: 1 },
  },
  ...partial,
})

const text = (value: string, partial: Partial<Extract<Part, { type: "text" }>> = {}): Part => ({
  id: "part-text",
  sessionID: "parent",
  messageID: "msg-2",
  type: "text",
  text: value,
  ...partial,
})

const messages = (ids: string[]) => ids.map((id) => ({ id }))

describe("parseTaskBlocks", () => {
  test("parses id, state, and inner content", () => {
    const blocks = parseTaskBlocks(
      ['<task id="child-1" state="completed">', "<summary>done</summary>", "<task_result>ok</task_result>", "</task>"].join(
        "",
      ),
    )
    expect(blocks).toEqual([
      { id: "child-1", state: "completed", inner: "<summary>done</summary><task_result>ok</task_result>" },
    ])
  })

  test("parses multiple blocks", () => {
    const blocks = parseTaskBlocks(`<task id="a" state="running">x</task> <task id="b" state="error">y</task>`)
    expect(blocks.map((block) => block.state)).toEqual(["running", "error"])
  })

  test("skips blocks without a state", () => {
    expect(parseTaskBlocks(`<task id="a">no state</task>`)).toEqual([])
  })
})

describe("deriveSessionTasks", () => {
  const status = (value: SessionStatus | undefined) => () => value

  test("tracks a running background task from a launch tool part", () => {
    const parts: Record<string, Part[]> = {
      "msg-1": [
        tool({
          state: {
            status: "completed",
            input: { description: "Fix the build", subagent_type: "general" },
            output: '<task id="child-1" state="running">Background task started</task>',
            title: "Fix the build",
            metadata: { sessionId: "child-1", background: true, jobId: "child-1" },
            time: { start: 100, end: 101 },
          } as Extract<Part, { type: "tool" }>["state"],
        }),
      ],
    }
    const tasks = deriveSessionTasks({
      messages: messages(["msg-1"]),
      parts: (id) => parts[id],
      status: status({ type: "busy" }),
    })
    expect(tasks).toEqual([
      {
        id: "child-1",
        title: "Fix the build",
        agent: "general",
        background: true,
        state: "running",
        startedAt: 100,
        summary: undefined,
      },
    ])
  })

  test("a background result block marks the task completed with its summary", () => {
    const launch: Part[] = [
      tool({
        state: {
          status: "completed",
          input: { description: "Write docs" },
          output: '<task id="child-1" state="running">started</task>',
          title: "Write docs",
          metadata: { sessionId: "child-1", background: true, jobId: "child-1" },
          time: { start: 100, end: 101 },
        } as Extract<Part, { type: "tool" }>["state"],
      }),
    ]
    const result: Part[] = [
      text(
        [
          "<task id=\"child-1\" state=\"completed\">",
          "<summary>Background task completed: Write docs</summary>",
          "<task_result>done</task_result>",
          "</task>",
        ].join("\n"),
      ),
    ]
    const tasks = deriveSessionTasks({
      messages: messages(["msg-1", "msg-2"]),
      parts: (id) => (id === "msg-1" ? launch : result),
      status: status({ type: "idle" }),
    })
    expect(tasks[0]).toMatchObject({
      id: "child-1",
      state: "completed",
      background: true,
      summary: "Background task completed: Write docs",
    })
  })

  test("a foreground task result shows completed from the tool part minus metadata", () => {
    const parts: Record<string, Part[]> = {
      "msg-1": [
        tool({
          state: {
            status: "completed",
            input: { description: "Sync files" },
            output: '<task id="child-2" state="completed"><task_result>ok</task_result></task>',
            title: "Sync files",
            metadata: { sessionId: "child-2" },
            time: { start: 10, end: 20 },
          } as Extract<Part, { type: "tool" }>["state"],
        }),
      ],
    }
    const tasks = deriveSessionTasks({
      messages: messages(["msg-1"]),
      parts: (id) => parts[id],
      status: status(undefined),
    })
    expect(tasks[0]).toMatchObject({ id: "child-2", state: "completed", background: false })
  })

  test("an error result block marks the task errored", () => {
    const parts: Record<string, Part[]> = {
      "msg-2": [text('<task id="child-9" state="error"><summary>failed</summary></task>')],
    }
    const tasks = deriveSessionTasks({
      messages: messages(["msg-2"]),
      parts: (id) => parts[id],
      status: status(undefined),
    })
    expect(tasks[0]).toMatchObject({ id: "child-9", state: "error", summary: "failed" })
  })

  test("a live running child session wins over a default running marker", () => {
    const parts: Record<string, Part[]> = {
      "msg-1": [
        tool({
          state: {
            status: "completed",
            input: { description: "Research" },
            output: '<task id="child-3" state="running">started</task>',
            title: "Research",
            metadata: { sessionId: "child-3", background: true, jobId: "child-3" },
            time: { start: 5, end: 6 },
          } as Extract<Part, { type: "tool" }>["state"],
        }),
      ],
    }
    const tasks = deriveSessionTasks({
      messages: messages(["msg-1"]),
      parts: (id) => parts[id],
      status: status({ type: "busy" }),
    })
    expect(tasks[0].state).toBe("running")
  })

  test("sorts by start time", () => {
    const parts: Record<string, Part[]> = {
      "msg-1": [
        tool({
          id: "p-later",
          callID: "c-later",
          state: {
            status: "completed",
            input: { description: "Later" },
            output: '<task id="later" state="running">x</task>',
            title: "Later",
            metadata: { sessionId: "later", background: true },
            time: { start: 200, end: 201 },
          } as Extract<Part, { type: "tool" }>["state"],
        }),
      ],
      "msg-2": [
        tool({
          id: "p-earlier",
          callID: "c-earlier",
          state: {
            status: "completed",
            input: { description: "Earlier" },
            output: '<task id="earlier" state="running">x</task>',
            title: "Earlier",
            metadata: { sessionId: "earlier", background: true },
            time: { start: 50, end: 51 },
          } as Extract<Part, { type: "tool" }>["state"],
        }),
      ],
    }
    const partsFn = (id: string) => parts[id]
    const tasks = deriveSessionTasks({
      messages: messages(["msg-1", "msg-2"]),
      parts: partsFn,
      status: status(undefined),
    })
    expect(tasks.map((task) => task.id)).toEqual(["earlier", "later"])
  })
})
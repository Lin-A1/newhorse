import { describe, expect, test } from "bun:test"
import type { MemoryAggregateGroup, MemoryInfo } from "@newhorse/sdk/v2"
import { exportMemory } from "./settings-memory-export"
import { splitAggregateByScope, splitByScope } from "./settings-memory-scope"

const records = [
  {
    id: "mem_1",
    scope: "project",
    kind: "preference",
    content: "concise",
    provenance: "user_confirmed",
    sensitivity: "normal",
    status: "active",
    timeCreated: 1,
    timeUpdated: 2,
  },
] satisfies MemoryInfo[]

const date = new Date("2030-01-02T03:04:00Z")

describe("exportMemory", () => {
  test("uses the native desktop save capability", async () => {
    const saved: unknown[] = []
    let downloads = 0
    await exportMemory(
      records,
      {
        saveTextFileDialog: async (input) => {
          saved.push(input)
          return "/tmp/memory.json"
        },
      },
      () => void downloads++,
      date,
    )

    expect(saved).toEqual([
      {
        title: "Export Memory",
        defaultPath: "newhorse-memory-2030-01-02.json",
        contents: JSON.stringify(records, null, 2),
      },
    ])
    expect(downloads).toBe(0)
  })

  test("uses a browser download when native saving is unavailable", async () => {
    const downloads: unknown[] = []
    await exportMemory(records, {}, (input) => downloads.push(input), date)
    expect(downloads).toEqual([
      {
        filename: "newhorse-memory-2030-01-02.json",
        contents: JSON.stringify(records, null, 2),
      },
    ])
  })
})

describe("splitByScope", () => {
  const item = (id: string, scope: MemoryInfo["scope"]): MemoryInfo => ({
    id,
    scope,
    kind: "fact",
    content: id,
    provenance: "user_confirmed",
    sensitivity: "normal",
    status: "active",
    timeCreated: 1,
    timeUpdated: 1,
  })

  test("splits a mixed list by scope type", () => {
    const items = [
      item("a", "project"),
      item("b", "user_global"),
      item("c", "personal"),
      item("d", "relationship"),
      item("e", "user_global"),
    ]
    expect(splitByScope(items).workspace.map((value) => value.id)).toEqual(["a", "c", "d"])
    expect(splitByScope(items).global.map((value) => value.id)).toEqual(["b", "e"])
  })

  test("handles empty and all-global lists", () => {
    expect(splitByScope([])).toEqual({ workspace: [], global: [] })
    const onlyGlobal = [item("g", "user_global")]
    expect(splitByScope(onlyGlobal).workspace).toEqual([])
    expect(splitByScope(onlyGlobal).global).toHaveLength(1)
  })
})

describe("splitAggregateByScope", () => {
  const group = (scope: MemoryAggregateGroup["scope"], id?: string): MemoryAggregateGroup => ({
    scope,
    ...(id ? { workspaceID: id } : {}),
    items: [],
  })

  test("splits aggregate groups by scope type", () => {
    const groups = [group("workspace", "ws_1"), group("user_global"), group("workspace", "ws_2")]
    expect(splitAggregateByScope(groups).workspace.map((value) => value.workspaceID)).toEqual(["ws_1", "ws_2"])
    expect(splitAggregateByScope(groups).global).toHaveLength(1)
  })
})

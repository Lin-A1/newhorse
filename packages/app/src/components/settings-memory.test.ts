import { describe, expect, test } from "bun:test"
import type { MemoryInfo } from "@newhorse/sdk/v2"
import { exportMemory } from "./settings-memory-export"

const records = [
  {
    id: "mem_1",
    scope: "workspace",
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

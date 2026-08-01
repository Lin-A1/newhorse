import { describe, expect, test } from "bun:test"
import { MAX_TEXT_FILE_BYTES, saveTextFile } from "./save-text-file"

describe("saveTextFile", () => {
  test("writes UTF-8 text to the user-selected JSON path", async () => {
    const selected: unknown[] = []
    const writes: unknown[] = []
    const result = await saveTextFile(
      {
        title: "Export Memory",
        defaultPath: "newhorse-memory.json",
        contents: '{"greeting":"你好"}',
      },
      {
        choose: async (options) => {
          selected.push(options)
          return { canceled: false, filePath: "/tmp/newhorse-memory.json" }
        },
        write: async (path, contents) => void writes.push({ path, contents }),
      },
    )

    expect(result).toBe("/tmp/newhorse-memory.json")
    expect(selected).toEqual([
      {
        title: "Export Memory",
        defaultPath: "newhorse-memory.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      },
    ])
    expect(writes).toEqual([{ path: "/tmp/newhorse-memory.json", contents: '{"greeting":"你好"}' }])
  })

  test("does not write when the picker is canceled", async () => {
    let writes = 0
    const result = await saveTextFile(
      { contents: "[]" },
      {
        choose: async () => ({ canceled: true }),
        write: async () => void writes++,
      },
    )
    expect(result).toBeNull()
    expect(writes).toBe(0)
  })

  test("rejects oversized UTF-8 content before opening the picker", async () => {
    let choices = 0
    await expect(
      saveTextFile(
        { contents: `你${"a".repeat(MAX_TEXT_FILE_BYTES - 2)}` },
        {
          choose: async () => {
            choices++
            return { canceled: true }
          },
          write: async () => {},
        },
      ),
    ).rejects.toThrow("10 MB limit")
    expect(choices).toBe(0)
  })

  test("rejects malformed and unbounded metadata", async () => {
    const deps = { choose: async () => ({ canceled: true }), write: async () => {} }
    await expect(saveTextFile({ contents: "[]", title: `bad\0title` }, deps)).rejects.toThrow("title is invalid")
    await expect(saveTextFile({ contents: "[]", defaultPath: `bad\0path` }, deps)).rejects.toThrow(
      "defaultPath is invalid",
    )
    await expect(saveTextFile({ contents: "[]", title: "a".repeat(513) }, deps)).rejects.toThrow("title is invalid")
  })

  test("rejects malformed payloads and propagates write failures", async () => {
    await expect(
      saveTextFile(null, { choose: async () => ({ canceled: true }), write: async () => {} }),
    ).rejects.toThrow("Invalid text file payload")
    await expect(
      saveTextFile(
        { contents: "[]" },
        {
          choose: async () => ({ canceled: false, filePath: "/tmp/fail.json" }),
          write: async () => {
            throw new Error("disk full")
          },
        },
      ),
    ).rejects.toThrow("disk full")
  })
})

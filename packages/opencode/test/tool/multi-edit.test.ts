import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { MultiEditTool } from "../../src/tool/multi-edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@newhorse/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-multi-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

const it = testEffect(layer)

const init = Effect.fn("MultiEditToolTest.init")(function* () {
  const info = yield* MultiEditTool
  return yield* info.init()
})

const run = Effect.fn("MultiEditToolTest.run")(function* (
  args: Tool.InferParameters<typeof MultiEditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("MultiEditToolTest.fail")(function* (args: Tool.InferParameters<typeof MultiEditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected multi_edit to fail")
})

const put = Effect.fn("MultiEditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("MultiEditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("MultiEditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

describe("tool.multi_edit", () => {
  describe("editing existing files", () => {
    it.instance("applies multiple edits to the same file in order", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo = 1\nbar = 2\nbaz = 3\n")

        const result = yield* run({
          filePath: filepath,
          edits: [
            { oldString: "foo = 1", newString: "foo = 10" },
            { oldString: "baz = 3", newString: "baz = 30" },
          ],
        })

        expect(result.output).toContain("MultiEdit applied successfully")
        expect(result.output).toContain("2 edit(s) applied")
        expect(yield* load(filepath)).toBe("foo = 10\nbar = 2\nbaz = 30\n")
      }),
    )

    it.instance("matches each edit against the content produced by the previous edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "alpha beta gamma")

        yield* run({
          filePath: filepath,
          edits: [
            { oldString: "beta", newString: "BETA" },
            { oldString: "alpha BETA", newString: "ALPHA BETA" },
          ],
        })

        expect(yield* load(filepath)).toBe("ALPHA BETA gamma")
      }),
    )

    it.instance("supports replaceAll on individual edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "a b a c a")

        yield* run({
          filePath: filepath,
          edits: [{ oldString: "a", newString: "x", replaceAll: true }],
        })

        expect(yield* load(filepath)).toBe("x b x c x")
      }),
    )

    it.instance("reports the number of applied edits in the output", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "one\ntwo")

        const result = yield* run({
          filePath: filepath,
          edits: [
            { oldString: "one", newString: "uno" },
            { oldString: "two", newString: "dos" },
            { oldString: "dos", newString: "dos-y" },
          ],
        })

        expect(result.output).toContain("3 edit(s) applied")
        expect(yield* load(filepath)).toBe("uno\ndos-y")
      }),
    )

    it.instance("exposes the full diff and file diff metadata", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({
          filePath: filepath,
          edits: [
            { oldString: "line1", newString: "first" },
            { oldString: "line3", newString: "third" },
          ],
        })

        expect(result.metadata.diff).toContain("-line1")
        expect(result.metadata.diff).toContain("+first")
        expect(result.metadata.diff).toContain("+third")
        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )
  })

  describe("failures", () => {
    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (
            yield* fail({
              filePath: path.join(test.directory, "nonexistent.txt"),
              edits: [{ oldString: "old", newString: "new" }],
            })
          ).message,
        ).toContain("not found")
      }),
    )

    it.instance("throws error when edits is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "file.txt"), edits: [] })).message,
        ).toContain("edits must contain at least one replacement")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        const fs = yield* FSUtil.Service
        yield* fs.makeDirectory(dirpath)

        expect(
          (
            yield* fail({
              filePath: dirpath,
              edits: [{ oldString: "old", newString: "new" }],
            })
          ).message,
        ).toContain("directory")
      }),
    )

    it.instance("aborts the whole batch and leaves the file unchanged when one edit fails", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        const original = "first\nsecond\nthird"
        yield* put(filepath, original)

        expect(
          (
            yield* fail({
              filePath: filepath,
              edits: [
                { oldString: "first", newString: "FIRST" },
                { oldString: "not present", newString: "never" },
                { oldString: "third", newString: "THIRD" },
              ],
            })
          ).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect(
          (
            yield* fail({
              filePath: filepath,
              edits: [{ oldString: "same", newString: "same" }],
            })
          ).message,
        ).toContain("identical")
      }),
    )

    it.instance("throws error when an edit has multiple matches without replaceAll", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        const original = "dup\nmiddle\ndup"
        yield* put(filepath, original)

        expect(
          (
            yield* fail({
              filePath: filepath,
              edits: [{ oldString: "dup", newString: "DUP" }],
            })
          ).message,
        ).toContain("multiple matches")
        expect(yield* load(filepath)).toBe(original)
      }),
    )
  })

  describe("line endings and BOM", () => {
    it.instance("preserves CRLF line endings across edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "one\r\ntwo\r\nthree")

        yield* run({
          filePath: filepath,
          edits: [
            { oldString: "one", newString: "first" },
            { oldString: "three", newString: "third" },
          ],
        })

        expect(yield* load(filepath)).toBe("first\r\ntwo\r\nthird")
      }),
    )

    it.instance("preserves a BOM across edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}foo bar`)

        yield* run({
          filePath: filepath,
          edits: [{ oldString: "foo", newString: "FOO" }],
        })

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("FOO bar")
      }),
    )
  })

  describe("permissions", () => {
    it.instance("asks with the edit permission and the relative file pattern", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        const asked: Array<Record<string, unknown>> = []
        const recordingCtx = {
          ...ctx,
          ask: (req: Parameters<Tool.Context["ask"]>[0]) =>
            Effect.gen(function* () {
              asked.push({
                permission: req.permission,
                patterns: [...req.patterns],
                metadata: req.metadata,
              })
            }),
        }

        yield* run(
          { filePath: filepath, edits: [{ oldString: "content", newString: "content2" }] },
          recordingCtx,
        )

        expect(asked.length).toBe(1)
        expect(asked[0].permission).toBe("edit")
        expect(asked[0].patterns).toHaveLength(1)
        expect((asked[0].metadata as { filepath?: string }).filepath).toBe(filepath)
        expect(yield* load(filepath)).toBe("content2")
      }),
    )
  })
})

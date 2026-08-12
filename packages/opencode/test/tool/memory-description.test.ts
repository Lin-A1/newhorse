import { describe, expect, test } from "bun:test"

import DESCRIPTION from "../../src/tool/memory.txt"
import { Parameters } from "../../src/tool/memory"
import { ToolJsonSchema } from "../../src/tool/json-schema"

// Guard against a regression where the tool description documented only a
// subset of the actions accepted by the parameters schema (previously only
// list/save/forget of the current 7). Both the "every declared action appears
// in the description" and the "documented set === declared set" assertions must
// hold so a drift in either direction fails the suite.

const declaredActions: string[] =
  (ToolJsonSchema.fromSchema(Parameters).properties?.action as { enum?: string[] } | undefined)?.enum ?? []

const documentedActions = [...DESCRIPTION.matchAll(/^- ([a-z_]+):/gm)].map((match) => match[1])

describe("memory tool description", () => {
  test("declares the full action list in the parameters schema", () => {
    expect(declaredActions).toEqual(["list", "search", "save", "forget", "consolidate", "archive", "clear"])
  })

  test("documents every declared action", () => {
    for (const action of declaredActions) {
      expect(DESCRIPTION, `action "${action}" is missing from memory.txt`).toContain(action)
    }
  })

  test("documented action set matches the schema's declared action set", () => {
    expect(new Set(documentedActions)).toEqual(new Set(declaredActions))
  })
})

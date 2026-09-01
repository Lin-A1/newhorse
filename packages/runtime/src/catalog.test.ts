import { describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findCatalogModel, loadModelCatalog, parseModelCatalog } from "./catalog"

describe("model capability catalog", () => {
  it("parses a valid catalog and drops malformed provider rows", () => {
    const catalog = parseModelCatalog({
      schemaVersion: 1,
      providers: [
        {
          id: "p1",
          name: "Provider One",
          endpoints: { baseURL: "https://p1", paths: { anthropic: "/anthropic/v1/messages" } },
          defaultKind: "anthropic",
          models: [
            { id: "m1", contextWindowTokens: 1048576, maxOutputTokens: 131072, kinds: ["anthropic", "openai-compatible"], reasoning: { defaultLevel: "max" } },
            { nope: true },
            { id: "" },
          ],
        },
        { broken: true },
        "junk",
      ],
    })
    expect(catalog).not.toBeNull()
    expect(catalog!.schemaVersion).toBe(1)
    expect(catalog!.providers.length).toBe(1)
    expect(catalog!.providers[0]!.models.length).toBe(1)
    expect(catalog!.providers[0]!.models[0]!.contextWindowTokens).toBe(1048576)
  })

  it("returns null for non-objects, empty providers, or provider rows without ids", () => {
    expect(parseModelCatalog(null)).toBeNull()
    expect(parseModelCatalog("x")).toBeNull()
    expect(parseModelCatalog({ providers: [] })).toBeNull()
    expect(parseModelCatalog({ providers: [{ models: [] }] })).toBeNull()
  })

  it("loads from <agentHome>/model-catalog.json and fails soft on a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nh-catalog-"))
    try {
      expect(await loadModelCatalog(dir)).toBeNull() // missing file: silent null

      await writeFile(join(dir, "model-catalog.json"), JSON.stringify({ schemaVersion: 1, providers: [{ id: "p", models: [{ id: "m" }] }] }))
      const loaded = await loadModelCatalog(dir)
      expect(loaded?.providers[0]!.id).toBe("p")

      await writeFile(join(dir, "model-catalog.json"), "{ broken")
      expect(await loadModelCatalog(dir)).toBeNull() // invalid JSON: fail-soft null

      await writeFile(join(dir, "model-catalog.json"), JSON.stringify({ providers: "nope" }))
      expect(await loadModelCatalog(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("finds a model by provider+id across providers", () => {
    const catalog = parseModelCatalog({
      providers: [
        { id: "a", models: [{ id: "shared" }, { id: "a1" }] },
        { id: "b", models: [{ id: "shared", contextWindowTokens: 8 }] },
      ],
    })
    expect(findCatalogModel(catalog, "b", "shared")?.contextWindowTokens).toBe(8)
    expect(findCatalogModel(catalog, "a", "a1")?.id).toBe("a1")
    expect(findCatalogModel(catalog, "zz", "shared")).toBeUndefined()
  })
})

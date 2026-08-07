import { describe, expect, test } from "bun:test"
import type { Agent, ModelV2Info } from "@newhorse/sdk/v2/client"
import { adaptModelCatalog, directoryKey, legacyModelCatalog, normalizeAgentList } from "./utils"

const agent = (name = "build") =>
  ({
    name,
    mode: "primary",
    permission: {},
    options: {},
  }) as Agent

describe("normalizeAgentList", () => {
  test("keeps array payloads", () => {
    expect(normalizeAgentList([agent("build"), agent("docs")])).toEqual([agent("build"), agent("docs")])
  })

  test("wraps a single agent payload", () => {
    expect(normalizeAgentList(agent("docs"))).toEqual([agent("docs")])
  })

  test("extracts agents from keyed objects", () => {
    expect(
      normalizeAgentList({
        build: agent("build"),
        docs: agent("docs"),
      }),
    ).toEqual([agent("build"), agent("docs")])
  })

  test("drops invalid payloads", () => {
    expect(normalizeAgentList({ name: "AbortError" })).toEqual([])
    expect(normalizeAgentList([{ name: "build" }, agent("docs")])).toEqual([agent("docs")])
  })
})

describe("adaptModelCatalog", () => {
  const model = (overrides: Partial<ModelV2Info> = {}): ModelV2Info => ({
    id: "claude-opus",
    providerID: "anthropic",
    family: "claude",
    name: "Claude Opus",
    api: { id: "anthropic", type: "aisdk", package: "@ai-sdk/anthropic", url: "https://example.test" },
    capabilities: { tools: true, input: ["text", "image", "reasoning"], output: ["text"] },
    request: { headers: { "x-test": "base" }, body: { temperature: 0.2 } },
    variants: [{ id: "fast", headers: { "x-speed": "fast" }, body: { speed: "fast" } }],
    time: { released: Date.UTC(2026, 0, 2) },
    cost: [
      { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
      {
        tier: { type: "context", size: 200_000 },
        input: 10,
        output: 37.5,
        cache: { read: 1, write: 12.5 },
      },
    ],
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, input: 900_000, output: 128_000 },
    ...overrides,
  })

  test("maps dynamic model fields and pricing tiers", () => {
    expect(adaptModelCatalog([model()])).toEqual([
      expect.objectContaining({
        id: "claude-opus",
        providerID: "anthropic",
        release_date: "2026-01-02T00:00:00.000Z",
        options: { temperature: 0.2 },
        headers: { "x-test": "base" },
        variants: { fast: { speed: "fast" } },
        limit: { context: 1_000_000, input: 900_000, output: 128_000 },
        capabilities: expect.objectContaining({ reasoning: true, attachment: true, toolcall: true }),
        cost: expect.objectContaining({
          input: 5,
          output: 25,
          cache: { read: 0.5, write: 6.25 },
          tiers: [
            {
              tier: { type: "context", size: 200_000 },
              input: 10,
              output: 37.5,
              cache: { read: 1, write: 12.5 },
            },
          ],
        }),
      }),
    ])
  })

  test("drops disabled and deprecated models", () => {
    expect(
      adaptModelCatalog([
        model({ id: "enabled" }),
        model({ id: "disabled", enabled: false }),
        model({ id: "deprecated", status: "deprecated" }),
      ]).map((item) => item.id),
    ).toEqual(["enabled"])
  })
})

describe("legacyModelCatalog", () => {
  test("flattens provider models for fallback", () => {
    expect(
      legacyModelCatalog({
        all: new Map([
          [
            "anthropic",
            {
              id: "anthropic",
              name: "Anthropic",
              source: "api",
              env: [],
              options: {},
              models: {
                opus: { id: "opus", providerID: "anthropic" } as never,
              },
            },
          ],
        ]),
        connected: ["anthropic"],
        default: { anthropic: "opus" },
      } as never),
    ).toHaveLength(1)
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\opencode"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/Repos/sst/opencode"))).toBe("C:/Repos/sst/opencode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/opencode/"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})

import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { SessionV1 } from "@newhorse/core/v1/session"
import { LLMEvent } from "@newhorse/llm"
import { ModelV2 } from "@newhorse/core/model"
import { ProviderV2 } from "@newhorse/core/provider"
import { ProjectV2 } from "@newhorse/core/project"
import { Memory } from "@/memory"
import { MemoryExtract } from "@/memory/extract"
import { LLM } from "@/session/llm"
import { Session } from "@/session/session"
import { Profile } from "@/profile"
import { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Unit tests for the post-turn memory extractor (@newhorse/MemoryExtract).
//
// All external services (Memory, LLM, Session) are replaced with in-memory
// mocks via LayerNode.compile replacements, so these tests exercise the
// extractor's own logic: the skip gates, dedup/cap, JSON parsing, and the
// shape of the save() calls — never a real database or model call.
// ---------------------------------------------------------------------------

const SESSION_ID = SessionID.make("sess_extract")
const USER_ID = "msg_extract_user"
const ASST_ID = "msg_extract_asst"
const ASSISTANT_TEXT = "I'll remember that for future turns."

const allowAll = [{ permission: "*" as const, pattern: "*" as const, action: "allow" as const }]

const agent: Agent.Info = {
  name: "newhorse",
  mode: "primary",
  permission: allowAll,
  options: {},
}

const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function textPart(
  messageID: string,
  text: string,
  opts: { synthetic?: boolean; ignored?: boolean } = {},
): SessionV1.TextPart {
  return {
    id: PartID.make(`prt_${messageID}`),
    sessionID: SESSION_ID,
    messageID: MessageID.make(messageID),
    type: "text",
    text,
    ...(opts.synthetic ? { synthetic: true as const } : {}),
    ...(opts.ignored ? { ignored: true as const } : {}),
  }
}

function userMessage(id: string, text: string, opts: { synthetic?: boolean; ignored?: boolean } = {}): SessionV1.WithParts {
  return {
    info: { id: MessageID.make(id), sessionID: SESSION_ID, role: "user" } as unknown as SessionV1.User,
    parts: [textPart(id, text, opts)],
  }
}

function assistantMessage(id: string, text: string): SessionV1.WithParts {
  return {
    info: { id: MessageID.make(id), sessionID: SESSION_ID, role: "assistant" } as unknown as SessionV1.Assistant,
    parts: [textPart(id, text)],
  }
}

function sessionInfo(parentID?: string): Session.Info {
  return {
    id: SESSION_ID,
    slug: "extract",
    projectID: ProjectV2.ID.make("proj_extract"),
    directory: "/tmp",
    title: "Extract test",
    version: "test",
    time: { created: 0, updated: 0 },
    parentID: parentID ? SessionID.make(parentID) : undefined,
    permission: allowAll,
  } as Session.Info
}

function runtimeProfile(overrides?: Partial<Profile.Runtime>): Profile.Runtime {
  return {
    id: Profile.ID.make("companion"),
    kind: "companion",
    name: "Companion",
    personaVersion: 1,
    memory: "ask",
    proactive: false,
    proactivePaused: false,
    proactiveFrequency: { maxPerDay: 3, minIntervalMinutes: 120 },
    dailySummary: true,
    ...overrides,
  }
}

function makeInput(overrides?: Partial<MemoryExtract.ExtractInput>): MemoryExtract.ExtractInput {
  const user = userMessage(USER_ID, "I prefer dark mode.")
  const assistant = assistantMessage(ASST_ID, ASSISTANT_TEXT)
  return {
    sessionID: SESSION_ID,
    session: sessionInfo(),
    profile: runtimeProfile(),
    agent,
    model,
    messages: [user],
    lastUser: user.info as SessionV1.User,
    lastAssistant: assistant.info as SessionV1.Assistant,
    ...overrides,
  }
}

type MockConfig = {
  /** The exact text the mocked LLM streams (one text-delta), or a stream factory. */
  llmText?: string | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)
  /** Contents the mocked Memory.search returns as related existing memories. */
  related?: string[]
  /** What Session.messages({ limit: 1 }) returns; defaults to the current assistant turn. */
  latest?: SessionV1.WithParts
  /** When set, save() fails with this error instead of succeeding. */
  saveError?: (input: Memory.SaveInput) => Memory.SensitiveMemoryRejected | Memory.MemoryPolicyRejected
}

function mockEnv(config: MockConfig = {}) {
  const saveCalls: Memory.SaveInput[] = []
  const searchCalls: unknown[] = []
  let llmCalls = 0

  const memoryMock = {
    search: (input: unknown) => {
      searchCalls.push(input)
      return Effect.succeed((config.related ?? []).map((content) => ({ content }) as unknown as Memory.Info))
    },
    save: (input: Memory.SaveInput) => {
      saveCalls.push(input)
      if (config.saveError) return Effect.fail(config.saveError(input))
      return Effect.succeed({ id: "mem_mock", content: input.content } as unknown as Memory.Info)
    },
  } as unknown as Memory.Interface

  const llmMock: LLM.Interface = {
    stream: (input) => {
      llmCalls += 1
      if (typeof config.llmText === "function") return config.llmText(input)
      const text = config.llmText ?? ""
      return text ? Stream.fromIterable([LLMEvent.textDelta({ id: "blk_extract", text })]) : Stream.empty
    },
  }

  const sessionMock = {
    messages: () => Effect.succeed([config.latest ?? assistantMessage(ASST_ID, ASSISTANT_TEXT)]),
  } as unknown as Session.Interface

  const layer = LayerNode.compile(MemoryExtract.node, [
    [Memory.node, Layer.succeed(Memory.Service, memoryMock)],
    [LLM.node, Layer.succeed(LLM.Service, llmMock)],
    [Session.node, Layer.succeed(Session.Service, sessionMock)],
  ])

  return { layer, saveCalls, searchCalls, llmCalls: () => llmCalls }
}

describe("MemoryExtract", () => {
  // ------------------------------------------------------------------ skip gates
  describe("skip gates", () => {
    const LLM_TEXT = '{"memories":[{"kind":"preference","content":"The user prefers dark mode"}]}'
    const workEnv = mockEnv({ llmText: LLM_TEXT })
    const offEnv = mockEnv({ llmText: LLM_TEXT })
    const forkedEnv = mockEnv({ llmText: LLM_TEXT })
    const syntheticEnv = mockEnv({ llmText: LLM_TEXT })

    testEffect(workEnv.layer).effect(
      "runs for work (assistant) profiles and saves the proposed kind",
      () =>
        Effect.gen(function* () {
          const extract = yield* MemoryExtract.Service
          yield* extract.extract(makeInput({ profile: runtimeProfile({ kind: "assistant", id: Profile.ID.make("assistant") }) }))
          expect(workEnv.saveCalls).toHaveLength(1)
          expect(workEnv.saveCalls[0]!.kind).toBe("preference")
          expect(workEnv.llmCalls()).toBe(1)
        }),
    )

    testEffect(offEnv.layer).effect(
      "does not run when memory policy is off",
      () =>
        Effect.gen(function* () {
          const extract = yield* MemoryExtract.Service
          yield* extract.extract(makeInput({ profile: runtimeProfile({ memory: "off" }) }))
          expect(offEnv.saveCalls).toHaveLength(0)
          expect(offEnv.llmCalls()).toBe(0)
        }),
    )

    testEffect(forkedEnv.layer).effect(
      "does not run for forked child sessions",
      () =>
        Effect.gen(function* () {
          const extract = yield* MemoryExtract.Service
          yield* extract.extract(makeInput({ session: sessionInfo("sess_parent") }))
          expect(forkedEnv.saveCalls).toHaveLength(0)
          expect(forkedEnv.llmCalls()).toBe(0)
        }),
    )

    testEffect(syntheticEnv.layer).effect(
      "does not run when the user turn has no real text",
      () =>
        Effect.gen(function* () {
          const extract = yield* MemoryExtract.Service
          const synthetic = userMessage(USER_ID, "synthetic text has no extractable user words", { synthetic: true })
          yield* extract.extract(
            makeInput({
              messages: [synthetic],
              lastUser: synthetic.info as SessionV1.User,
            }),
          )
          expect(syntheticEnv.saveCalls).toHaveLength(0)
          expect(syntheticEnv.llmCalls()).toBe(0)
        }),
    )
  })

  // ------------------------------------------------------------ LLM JSON parsing
  describe("LLM output parsing", () => {
    const env = mockEnv({ llmText: '{"memories":[{"kind":"preference","content":"The user prefers dark mode"}]}' })
    testEffect(env.layer).effect("saves a memory from a plain JSON reply", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(env.saveCalls).toHaveLength(1)
        expect(env.saveCalls[0]?.content).toBe("The user prefers dark mode")
      }),
    )

    const fencedJson = mockEnv({
      llmText: '```json\n{"memories":[{"kind":"fact","content":"The user is learning Spanish"}]}\n```',
    })
    testEffect(fencedJson.layer).effect("strips a ```json code fence before parsing", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(fencedJson.saveCalls).toHaveLength(1)
        expect(fencedJson.saveCalls[0]?.content).toBe("The user is learning Spanish")
      }),
    )

    const fencedBare = mockEnv({ llmText: '```\n{"memories":[{"kind":"goal","content":"The user wants to run a marathon"}]}\n```' })
    testEffect(fencedBare.layer).effect("strips a bare ``` code fence before parsing", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(fencedBare.saveCalls).toHaveLength(1)
        expect(fencedBare.saveCalls[0]?.content).toBe("The user wants to run a marathon")
      }),
    )

    const prose = mockEnv({
      llmText: 'Sure, here:\n{"memories":[{"kind":"event","content":"The user ran a 5k last weekend"}]}\nHope that helps!',
    })
    testEffect(prose.layer).effect("extracts JSON embedded in prose", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(prose.saveCalls).toHaveLength(1)
        expect(prose.saveCalls[0]?.content).toBe("The user ran a 5k last weekend")
      }),
    )

    const invalid = mockEnv({ llmText: "this is not JSON at all" })
    testEffect(invalid.layer).effect("ignores unparseable output without crashing", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(invalid.saveCalls).toHaveLength(0)
      }),
    )

    const wrongShape = mockEnv({ llmText: '{"memories":[{"kind":"bogus","content":"The user likes trains"}]}' })
    testEffect(wrongShape.layer).effect("ignores a reply whose shape fails schema decoding", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(wrongShape.saveCalls).toHaveLength(0)
      }),
    )

    const empty = mockEnv({ llmText: '{"memories":[]}' })
    testEffect(empty.layer).effect("saves nothing for an empty memories array", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(empty.saveCalls).toHaveLength(0)
      }),
    )

    const streamFail = mockEnv({ llmText: () => Stream.failSync(() => new Error("llm boom")) })
    testEffect(streamFail.layer).effect("tolerates a failing LLM stream", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(streamFail.saveCalls).toHaveLength(0)
      }),
    )
  })

  // ------------------------------------------------------------ dedup and cap
  describe("dedup and cap", () => {
    const cap = mockEnv({
      llmText: JSON.stringify({
        memories: [
          { kind: "fact", content: "The user was born in Lisbon" },
          { kind: "fact", content: "The user collects vintage cameras" },
          { kind: "fact", content: "The user prefers herbal tea" },
          { kind: "fact", content: "The user is learning Spanish" },
          { kind: "fact", content: "The user runs five kilometers daily" },
          { kind: "fact", content: "The user works as a marine biologist" },
          { kind: "fact", content: "The user reads before bed" },
        ],
      }),
    })
    testEffect(cap.layer).effect("caps saved memories at 5", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(cap.saveCalls).toHaveLength(5)
        expect(cap.saveCalls.map((item) => item.content)).toEqual([
          "The user was born in Lisbon",
          "The user collects vintage cameras",
          "The user prefers herbal tea",
          "The user is learning Spanish",
          "The user runs five kilometers daily",
        ])
      }),
    )

    const dup = mockEnv({
      related: ["The user prefers dark mode"],
      llmText: JSON.stringify({
        memories: [
          { kind: "preference", content: "The user prefers dark mode" },
          { kind: "preference", content: "The user prefers dark mode and quiet evenings" },
          { kind: "preference", content: "The user enjoys reading novels" },
        ],
      }),
    })
    testEffect(dup.layer).effect("skips candidates that duplicate an existing memory", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(dup.saveCalls).toHaveLength(1)
        expect(dup.saveCalls[0]?.content).toBe("The user enjoys reading novels")
      }),
    )

    const overlap = mockEnv({
      related: ["the user enjoys hiking in the mountains every weekend"],
      llmText: JSON.stringify({
        memories: [{ kind: "fact", content: "the user loves hiking in the mountains on weekends" }],
      }),
    })
    testEffect(overlap.layer).effect("skips candidates with >= 0.6 token overlap with an existing memory", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(overlap.saveCalls).toHaveLength(0)
      }),
    )

    const dupThenCap = mockEnv({
      related: ["The user prefers dark mode"],
      llmText: JSON.stringify({
        memories: [
          { kind: "preference", content: "The user prefers dark mode" },
          { kind: "preference", content: "The user likes coffee" },
        ],
      }),
    })
    testEffect(dupThenCap.layer).effect("skips duplicates before applying the cap", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(dupThenCap.saveCalls).toHaveLength(1)
        expect(dupThenCap.saveCalls[0]?.content).toBe("The user likes coffee")
      }),
    )

    const whitespace = mockEnv({ llmText: '{"memories":[{"kind":"preference","content":"   "}]}' })
    testEffect(whitespace.layer).effect("drops whitespace-only candidates", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(whitespace.saveCalls).toHaveLength(0)
      }),
    )

    const allDup = mockEnv({
      related: ["The user prefers dark mode"],
      llmText: '{"memories":[{"kind":"preference","content":"The user prefers dark mode"}]}',
    })
    testEffect(allDup.layer).effect("returns early when every candidate is a duplicate", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(allDup.saveCalls).toHaveLength(0)
      }),
    )

    const sameBatchIdentical = mockEnv({
      llmText: JSON.stringify({
        memories: [
          { kind: "preference", content: "The user enjoys reading novels" },
          { kind: "preference", content: "The user enjoys reading novels" },
          { kind: "preference", content: "The user prefers green tea" },
        ],
      }),
    })
    testEffect(sameBatchIdentical.layer).effect("saves only one of two identical candidates from the same batch", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(sameBatchIdentical.saveCalls).toHaveLength(2)
        expect(sameBatchIdentical.saveCalls.map((item) => item.content)).toEqual([
          "The user enjoys reading novels",
          "The user prefers green tea",
        ])
      }),
    )

    const sameBatchContainment = mockEnv({
      llmText: JSON.stringify({
        memories: [
          { kind: "preference", content: "The user prefers dark mode and quiet evenings" },
          { kind: "preference", content: "The user prefers dark mode" },
          { kind: "preference", content: "The user likes to swim" },
        ],
      }),
    })
    testEffect(sameBatchContainment.layer).effect("saves only one of two containment-duplicate candidates from the same batch", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(sameBatchContainment.saveCalls).toHaveLength(2)
        expect(sameBatchContainment.saveCalls.map((item) => item.content)).toEqual([
          "The user prefers dark mode and quiet evenings",
          "The user likes to swim",
        ])
      }),
    )

    const sameBatchDupThenCap = mockEnv({
      llmText: JSON.stringify({
        memories: [
          { kind: "fact", content: "The user collects vintage cameras" },
          { kind: "fact", content: "The user collects vintage cameras" },
          { kind: "fact", content: "The user prefers herbal tea" },
          { kind: "fact", content: "The user is learning Spanish" },
          { kind: "fact", content: "The user runs five kilometers daily" },
          { kind: "fact", content: "The user works as a marine biologist" },
        ],
      }),
    })
    testEffect(sameBatchDupThenCap.layer).effect("filters same-batch duplicates before applying the cap", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(sameBatchDupThenCap.saveCalls).toHaveLength(5)
        expect(sameBatchDupThenCap.saveCalls.map((item) => item.content)).toEqual([
          "The user collects vintage cameras",
          "The user prefers herbal tea",
          "The user is learning Spanish",
          "The user runs five kilometers daily",
          "The user works as a marine biologist",
        ])
      }),
    )
  })

  // ------------------------------------------------------------ save semantics
  describe("save semantics", () => {
    const save = mockEnv({ llmText: '{"memories":[{"kind":"preference","content":"The user prefers dark mode"}]}' })
    testEffect(save.layer).effect("saves proposals as model_inferred relationship memory with source attribution", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(save.saveCalls).toHaveLength(1)
        expect(save.saveCalls[0]).toMatchObject({
          content: "The user prefers dark mode",
          kind: "relationship",
          provenance: "model_inferred",
          profileID: "companion",
          sourceSessionID: SESSION_ID,
          sourceMessageID: MessageID.make(ASST_ID),
          userRuleset: allowAll,
        })
      }),
    )

    const search = mockEnv({ llmText: '{"memories":[{"kind":"preference","content":"The user prefers dark mode"}]}' })
    testEffect(search.layer).effect("queries related memory as relationship-only proposals for the profile", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(search.searchCalls).toHaveLength(1)
        expect(search.searchCalls[0]).toMatchObject({
          profileID: "companion",
          relationshipOnly: true,
          status: ["active", "proposed"],
          limit: 10,
          userRuleset: allowAll,
        })
      }),
    )
  })

  // ------------------------------------------------------------ save failure handling
  describe("save failure handling", () => {
    const sensitive = mockEnv({
      llmText: '{"memories":[{"kind":"preference","content":"The user prefers dark mode"}]}',
      saveError: () => new Memory.SensitiveMemoryRejected(),
    })
    testEffect(sensitive.layer).effect("tolerates a sensitive-proposal rejection without aborting the run", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(sensitive.saveCalls).toHaveLength(1)
      }),
    )

    const policy = mockEnv({
      llmText: '{"memories":[{"kind":"preference","content":"The user prefers dark mode"}]}',
      saveError: () => new Memory.MemoryPolicyRejected({ reason: "empty_content", message: "rejected by policy" }),
    })
    testEffect(policy.layer).effect("tolerates a policy rejection without aborting the run", () =>
      Effect.gen(function* () {
        const extract = yield* MemoryExtract.Service
        yield* extract.extract(makeInput())
        expect(policy.saveCalls).toHaveLength(1)
      }),
    )
  })
})

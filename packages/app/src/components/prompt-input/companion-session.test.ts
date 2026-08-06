import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@newhorse/sdk/v2/client"
import type { DirectorySDK } from "@/context/sdk"
import { ensureCompanionSession, getPinnedCompanion, pinCompanion } from "./companion-session"

const scope = "local"
const directory = "C:/Projects/Demo"

function fakeClient(overrides: { create?: () => unknown }): DirectorySDK["client"] {
  return { session: { create: async () => ({ data: overrides.create?.() }) } } as unknown as DirectorySDK["client"]
}

beforeEach(() => {
  localStorage.clear()
})

describe("ensureCompanionSession", () => {
  test("creates and pins a session on first use", async () => {
    const created = { id: "ses_1", directory, profileID: "companion" } as Session
    const result = await ensureCompanionSession({
      client: fakeClient({ create: () => created }),
      directory,
      scope,
      fetch: async () => undefined,
      list: async () => [],
    })
    expect(result.session.id).toBe("ses_1")
    expect(result.directory).toBe(directory)
    expect(getPinnedCompanion(scope)?.sessionID).toBe("ses_1")
  })

  test("reuses the pinned session from its own directory", async () => {
    pinCompanion(scope, "ses_pinned", "C:/Old/Project")
    const existing = { id: "ses_pinned", directory: "C:/Old/Project", profileID: "companion" } as Session
    const result = await ensureCompanionSession({
      client: fakeClient({}),
      directory,
      scope,
      fetch: async (dir, id) => (dir === "C:/Old/Project" && id === "ses_pinned" ? existing : undefined),
      list: async () => [],
    })
    expect(result.session.id).toBe("ses_pinned")
    expect(result.directory).toBe("C:/Old/Project")
  })

  test("adopts the most recent existing companion session when nothing is pinned", async () => {
    const older = { id: "ses_old", directory, profileID: "companion", time: { updated: 100 } } as Session
    const newer = { id: "ses_newer", directory, profileID: "companion", time: { updated: 200 } } as Session
    const result = await ensureCompanionSession({
      client: fakeClient({}),
      directory,
      scope,
      fetch: async () => undefined,
      list: async () => [older, newer, { id: "ses_assistant", profileID: "assistant" } as Session],
    })
    expect(result.session.id).toBe("ses_newer")
    expect(getPinnedCompanion(scope)?.sessionID).toBe("ses_newer")
  })

  test("recreates when the pinned session no longer exists", async () => {
    pinCompanion(scope, "ses_gone", "C:/Old/Project")
    const created = { id: "ses_new", directory, profileID: "companion" } as Session
    const result = await ensureCompanionSession({
      client: fakeClient({ create: () => created }),
      directory,
      scope,
      fetch: async () => undefined,
      list: async () => [],
    })
    expect(result.session.id).toBe("ses_new")
    expect(getPinnedCompanion(scope)?.sessionID).toBe("ses_new")
  })

  test("deduplicates concurrent first use per server", async () => {
    let creates = 0
    const created = { id: "ses_once", directory, profileID: "companion" } as Session
    const client = fakeClient({
      create: () => {
        creates++
        return created
      },
    })
    const input = {
      client,
      directory,
      scope,
      fetch: async () => undefined,
      list: async () => [],
    }
    const [first, second] = await Promise.all([ensureCompanionSession(input), ensureCompanionSession(input)])
    expect(first.session.id).toBe("ses_once")
    expect(second.session.id).toBe("ses_once")
    expect(creates).toBe(1)
  })

  test("ignores a pinned non-companion session", async () => {
    pinCompanion(scope, "ses_wrong", "C:/Old/Project")
    const wrong = { id: "ses_wrong", directory: "C:/Old/Project", profileID: "assistant" } as Session
    const existing = { id: "ses_companion", directory, profileID: "companion" } as Session
    const result = await ensureCompanionSession({
      client: fakeClient({}),
      directory,
      scope,
      fetch: async () => wrong,
      list: async () => [existing],
    })
    expect(result.session.id).toBe("ses_companion")
    expect(getPinnedCompanion(scope)?.sessionID).toBe("ses_companion")
  })

  test("uses a Companion session from another directory in the global list", async () => {
    const existing = { id: "ses_global", directory: "C:/Personal", profileID: "companion", time: { updated: 300 } } as Session
    const result = await ensureCompanionSession({
      client: fakeClient({}),
      directory,
      scope,
      fetch: async () => undefined,
      globalList: async () => [existing],
      list: async () => [],
    })
    expect(result.session.id).toBe("ses_global")
    expect(result.directory).toBe("C:/Personal")
  })

  test("does not create when the pinned lookup fails with a non-404 error", async () => {
    let creates = 0
    pinCompanion(scope, "ses_error", "C:/Personal")
    await expect(
      ensureCompanionSession({
        client: fakeClient({ create: () => { creates++; return { id: "unexpected" } } }),
        directory,
        scope,
        fetch: async () => { throw Object.assign(new Error("network"), { status: 503 }) },
        list: async () => [],
      }),
    ).rejects.toThrow("network")
    expect(creates).toBe(0)
  })
  test("throws when creation fails", async () => {
    await expect(
      ensureCompanionSession({
        client: fakeClient({ create: () => undefined }),
        directory,
        scope,
        fetch: async () => undefined,
        list: async () => [],
      }),
    ).rejects.toThrow()
  })
})

import type { Session } from "@newhorse/sdk/v2/client"
import type { DirectorySDK } from "@/context/sdk"

const COMPANION_PIN_KEY = "newhorse.companion-session.v1"

type CompanionPin = { sessionID: string; directory: string }

function readPins(): Record<string, CompanionPin> {
  try {
    const raw = localStorage.getItem(COMPANION_PIN_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, CompanionPin>) : {}
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writePins(pins: Record<string, CompanionPin>) {
  try {
    localStorage.setItem(COMPANION_PIN_KEY, JSON.stringify(pins))
  } catch {
    // Storage unavailable (e.g. private mode) — the pinned session still works
    // for this turn, it just isn't remembered across launches.
  }
}

export function getPinnedCompanion(scope: string): CompanionPin | undefined {
  return readPins()[scope]
}

export function pinCompanion(scope: string, sessionID: string, directory: string) {
  const pins = readPins()
  pins[scope] = { sessionID, directory }
  writePins(pins)
}

export type CompanionSessionResult = { session: Session; directory: string }

export type PersonalWorkspaceRef = { directory: string; workspaceID: string }

const PERSONAL_WORKSPACE_KEY = "newhorse.personal-workspace.v1"
const companionLocks = new Map<string, Promise<CompanionSessionResult>>()

function readPersonalWorkspaces(): Record<string, PersonalWorkspaceRef> {
  try {
    const raw = localStorage.getItem(PERSONAL_WORKSPACE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, PersonalWorkspaceRef>) : {}
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writePersonalWorkspace(scope: string, ref: PersonalWorkspaceRef) {
  try {
    const all = readPersonalWorkspaces()
    all[scope] = ref
    localStorage.setItem(PERSONAL_WORKSPACE_KEY, JSON.stringify(all))
  } catch {
    // Storage unavailable — the resolved workspace still works for this turn.
  }
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as { status?: unknown; response?: { status?: unknown }; cause?: { status?: unknown } }
  return value.status === 404 || value.response?.status === 404 || value.cause?.status === 404
}

/**
 * Resolve (or create) the user's Personal workspace. The Companion's
 * relationship memories are only permitted in a Personal scope — the trust
 * policy rejects `relationship` writes from a project scope — so the pinned
 * Companion session must live in a personal workspace for memory extraction to
 * stick and for the Memory Center to surface it.
 *
 * The resolved workspace is cached per server scope so opening the Companion
 * again reuses it instead of creating a fresh personal workspace every time.
 */
export async function ensurePersonalWorkspace(
  client: DirectorySDK["client"],
  scope?: string,
): Promise<PersonalWorkspaceRef | undefined> {
  if (scope) {
    const cached = readPersonalWorkspaces()[scope]
    if (cached?.directory && cached.workspaceID) return cached
  }
  const existing = await client.experimental.workspace
    .personal({})
    .then((result) => result.data ?? [])
    .catch(() => [] as { id: string; name: string; directory: string; notes: number }[])
  const first = existing.find((item) => item.directory)
  if (first?.directory) {
    const ref: PersonalWorkspaceRef = { directory: first.directory, workspaceID: first.id }
    if (scope) writePersonalWorkspace(scope, ref)
    return ref
  }
  const created = await client.experimental.workspace
    .create({ type: "personal", branch: null, extra: null })
    .then((result) => result.data)
  if (!created?.directory) return undefined
  const ref: PersonalWorkspaceRef = { directory: created.directory, workspaceID: created.id }
  if (scope) writePersonalWorkspace(scope, ref)
  return ref
}

async function resolveCompanionSession(input: {
  client: DirectorySDK["client"]
  directory: string
  scope: string
  fetch: (directory: string, sessionID: string) => Promise<Session | undefined>
  globalList?: () => Promise<Session[]>
  list?: (directory: string) => Promise<Session[]>
  resolvePersonal?: () => Promise<PersonalWorkspaceRef | undefined>
  createClient?: (opts: { directory: string; experimental_workspaceID?: string }) => DirectorySDK["client"]
}): Promise<CompanionSessionResult> {
  // The Companion is one global continuous session. A valid pinned session wins
  // outright — its directory is where we stay.
  const pinned = getPinnedCompanion(input.scope)
  if (pinned) {
    let existing: Session | undefined
    try {
      existing = await input.fetch(pinned.directory, pinned.sessionID)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    if (existing && existing.profileID === "companion" && !existing.time?.archived) {
      return { session: existing, directory: pinned.directory }
    }
  }

  // Otherwise anchor to an existing Companion session (most recent wins) so
  // opening the Companion never spins up a fresh personal workspace. Only when
  // there is no Companion session at all do we resolve/create a personal
  // workspace, so relationship memory lands in a personal scope.
  const anchor = input.globalList
    ? (await input.globalList())
        .filter((session) => session.profileID === "companion" && !session.time?.archived)
        .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
    : undefined
  const personal = anchor ? undefined : await input.resolvePersonal?.().catch(() => undefined)
  const homeDirectory = anchor?.directory ?? personal?.directory ?? input.directory
  const client =
    homeDirectory !== input.directory && input.createClient
      ? input.createClient({
          directory: homeDirectory,
          experimental_workspaceID: personal?.workspaceID,
        })
      : input.client

  // Reuse the anchor session when it already lives in the home directory.
  if (anchor && anchor.directory === homeDirectory) {
    pinCompanion(input.scope, anchor.id, anchor.directory)
    return { session: anchor, directory: anchor.directory }
  }
  if (input.list) {
    const existing = (await input.list(homeDirectory))
      .filter((session) => session.profileID === "companion" && session.directory === homeDirectory)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
    if (existing) {
      pinCompanion(input.scope, existing.id, existing.directory ?? homeDirectory)
      return { session: existing, directory: existing.directory ?? homeDirectory }
    }
  }

  const created = await client.session.create({ profileID: "companion" }).then((result) => result.data)
  if (!created) throw new Error("Failed to create companion session")
  pinCompanion(input.scope, created.id, homeDirectory)
  return { session: created, directory: homeDirectory }
}

export async function ensureCompanionSession(input: {
  client: DirectorySDK["client"]
  directory: string
  scope: string
  fetch: (directory: string, sessionID: string) => Promise<Session | undefined>
  globalList?: () => Promise<Session[]>
  list?: (directory: string) => Promise<Session[]>
  resolvePersonal?: () => Promise<PersonalWorkspaceRef | undefined>
  createClient?: (opts: { directory: string; experimental_workspaceID?: string }) => DirectorySDK["client"]
}): Promise<CompanionSessionResult> {
  const active = companionLocks.get(input.scope)
  if (active) return active
  const operation = resolveCompanionSession(input)
  companionLocks.set(input.scope, operation)
  try {
    return await operation
  } finally {
    if (companionLocks.get(input.scope) === operation) companionLocks.delete(input.scope)
  }
}

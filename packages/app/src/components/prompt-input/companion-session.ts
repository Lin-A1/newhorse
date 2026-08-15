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

const companionLocks = new Map<string, Promise<CompanionSessionResult>>()

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
 */
export async function ensurePersonalWorkspace(
  client: DirectorySDK["client"],
): Promise<PersonalWorkspaceRef | undefined> {
  const existing = await client.experimental.workspace
    .personal({})
    .then((result) => result.data ?? [])
    .catch(() => [] as { id: string; name: string; directory: string; notes: number }[])
  const first = existing.find((item) => item.directory)
  if (first?.directory) return { directory: first.directory, workspaceID: first.id }
  const created = await client.experimental.workspace
    .create({ type: "personal", branch: null, extra: null })
    .then((result) => result.data)
  if (!created?.directory) return undefined
  return { directory: created.directory, workspaceID: created.id }
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
  if (input.globalList) {
    const existing = (await input.globalList())
      .filter((session) => session.profileID === "companion" && !session.time?.archived)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
    if (existing) {
      pinCompanion(input.scope, existing.id, existing.directory ?? input.directory)
      return { session: existing, directory: existing.directory ?? input.directory }
    }
  }
  if (input.list) {
    const existing = (await input.list(input.directory))
      .filter((session) => session.profileID === "companion")
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
    if (existing) {
      pinCompanion(input.scope, existing.id, existing.directory ?? input.directory)
      return { session: existing, directory: existing.directory ?? input.directory }
    }
  }

  // Create the Companion session inside a Personal workspace so relationship
  // memories pass the trust policy and surface in the Memory Center. Falls back
  // to the current directory when no personal workspace can be resolved.
  const personal = await input.resolvePersonal?.().catch(() => undefined)
  const client = personal && input.createClient
    ? input.createClient({ directory: personal.directory, experimental_workspaceID: personal.workspaceID })
    : input.client
  const created = await client.session.create({ profileID: "companion" }).then((result) => result.data)
  if (!created) throw new Error("Failed to create companion session")
  const directory = personal?.directory ?? input.directory
  pinCompanion(input.scope, created.id, directory)
  return { session: created, directory }
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

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

const companionLocks = new Map<string, Promise<CompanionSessionResult>>()

async function resolveCompanionSession(input: {
  client: DirectorySDK["client"]
  directory: string
  scope: string
  fetch: (directory: string, sessionID: string) => Promise<Session | undefined>
  list?: (directory: string) => Promise<Session[]>
}): Promise<CompanionSessionResult> {
  const pinned = getPinnedCompanion(input.scope)
  if (pinned) {
    const existing = await input.fetch(pinned.directory, pinned.sessionID)
    if (existing && existing.profileID === "companion") return { session: existing, directory: pinned.directory }
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
  const created = await input.client.session.create({ profileID: "companion" }).then((result) => result.data)
  if (!created) throw new Error("Failed to create companion session")
  pinCompanion(input.scope, created.id, input.directory)
  return { session: created, directory: input.directory }
}

export async function ensureCompanionSession(input: {
  client: DirectorySDK["client"]
  directory: string
  scope: string
  fetch: (directory: string, sessionID: string) => Promise<Session | undefined>
  list?: (directory: string) => Promise<Session[]>
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

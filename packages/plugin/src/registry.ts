import type { Container, Disposer, ServiceDefinition } from "@newhorse/core"
import type { Tool } from "@newhorse/core"

/**
 * Plugin registration surface.
 *
 * Five capabilities register through one seam (tool / agent / command / hook /
 * provider), so the consumer pulls from the registry rather than branching on
 * types inline (AGENTS.md "no scattered type branches"). Each registration
 * returns a disposer, so a plugin can be torn down cleanly.
 * Directory-as-registration-surface is layered on top: a plugin folder exposes
 * these capabilities and gets discovered by convention.
 *
 * Skills are handled separately (see discovery.ts): AGENTS.md's three-level
 * skill disclosure (metadata → SKILL.md → references/scripts) is a content
 * convention, not a registry kind — a skill is discovered by convention and
 * consumed as model-visible context, so it does not get a Capability slot here.
 */

/** A tool capability IS the core Tool shape, plus the registration kind. */
export type ToolCapability = Tool & { readonly kind: "tool" }

export interface AgentCapability {
  readonly kind: "agent"
  readonly name: string
  readonly description?: string
  /** System body (specialist instructions). Injected into a child's context. */
  readonly body?: string
  /** Tool whitelist: the agent may use ONLY these (restrictive overlay). */
  readonly allowedTools?: readonly string[]
  /** Role key (costDown / scheduling reference). */
  readonly role?: string
  readonly model?: string
}

export interface CommandCapability {
  readonly kind: "command"
  readonly name: string
  readonly description?: string
  readonly run: (args: string[]) => Promise<unknown>
}

/**
 * Hook events, kept open so adding a new event is not a breaking type change:
 * known events get autocomplete, unknown strings still type-check. Runtime
 * discovery validates against a whitelist (see discovery.ts).
 */
export type HookEvent =
  | "pre-tool-use"
  | "post-tool-use"
  | "user-prompt-submit"
  | "stop"
  | "subagent-start"
  | "subagent-stop"
  | (string & {})

export const HOOK_EVENTS: ReadonlySet<string> = new Set([
  "pre-tool-use",
  "post-tool-use",
  "user-prompt-submit",
  "stop",
  "subagent-start",
  "subagent-stop",
])

export interface HookCapability {
  readonly kind: "hook"
  readonly name: string
  readonly event: HookEvent
  /** Deterministic command hook (bash) or LLM-decided prompt hook. */
  readonly mode: "command" | "prompt"
  readonly run: (input: unknown) => Promise<unknown>
}

export interface ProviderCapability {
  readonly kind: "provider"
  readonly id: string
  readonly register: (container: Container) => Disposer
}

export type Capability = ToolCapability | AgentCapability | CommandCapability | HookCapability | ProviderCapability

export type CapabilityKind = Capability["kind"]

/**
 * Registry that stores registered capabilities by kind + name. Consumers read
 * a kind they care about (e.g. the tool resolver pulls all `tool` entries),
 * never switching on a concrete type inline.
 *
 * A plugin can also drive a Container (ProviderCapability). The disposer
 * returned by provider.register(container) is composed into the capability
 * disposer, so tearing down the capability also un-registers its Container
 * entries. `PluginRegistry.dispose()` tears down every registration in reverse
 * order — the bulk-unload path for a discovered plugin.
 */
export class PluginRegistry {
  readonly #store = new Map<CapabilityKind, Map<string, Capability>>()
  readonly #disposers: Array<() => void> = []
  readonly #container?: Container

  constructor(container?: Container) {
    this.#container = container
  }

  register(capability: Capability): Disposer {
    const bucket = this.#store.get(capability.kind) ?? new Map<string, Capability>()
    const key = this.#key(capability)
    if (bucket.has(key)) {
      throw new PluginError(`capability "${key}" already registered`)
    }
    bucket.set(key, capability)
    this.#store.set(capability.kind, bucket)

    // Compose inner Container disposers (from a provider) into the returned one.
    const innerDisposer = capability.kind === "provider" && this.#container ? capability.register(this.#container) : undefined
    const disposer = (): void => {
      bucket.delete(key)
      innerDisposer?.()
    }
    this.#disposers.push(disposer)
    return disposer
  }

  /** Register many capabilities; returns a single disposer for all of them. */
  registerAll(capabilities: readonly Capability[]): Disposer {
    const disposers = capabilities.map((c) => this.register(c))
    return () => {
      for (let i = disposers.length - 1; i >= 0; i--) disposers[i]!()
    }
  }

  /** Register discovered capabilities, skipping (not throwing) on a name
   *  collision. Directory-as-registration-surface is convention-based and a
   *  self-contained plugin folder should never brick an app build over a name
   *  clash; first-wins keeps the discovered order stable and the dupe silent.
   *  Explicit `register`/`registerAll` stay strict (fail-fast is right there). */
  registerDiscovered(capabilities: readonly Capability[]): Disposer {
    const disposers: Array<() => void> = []
    for (const c of capabilities) {
      const bucket = this.#store.get(c.kind) ?? new Map<string, Capability>()
      const key = this.#key(c)
      if (bucket.has(key)) continue
      disposers.push(this.register(c))
    }
    return () => {
      for (let i = disposers.length - 1; i >= 0; i--) disposers[i]!()
    }
  }

  list<K extends CapabilityKind>(kind: K): Array<Extract<Capability, { kind: K }>> {
    const bucket = this.#store.get(kind)
    if (!bucket) return []
    return [...bucket.values()] as Array<Extract<Capability, { kind: K }>>
  }

  get<K extends CapabilityKind>(kind: K, name: string): Extract<Capability, { kind: K }> | undefined {
    return this.#store.get(kind)?.get(name) as Extract<Capability, { kind: K }> | undefined
  }

  /** Collect every capability across kinds (for wiring into a Container). */
  all(): Capability[] {
    const out: Capability[] = []
    for (const bucket of this.#store.values()) out.push(...bucket.values())
    return out
  }

  /** Tear down every registration in reverse order (bulk unload). */
  dispose(): void {
    for (let i = this.#disposers.length - 1; i >= 0; i--) this.#disposers[i]!()
    this.#store.clear()
    this.#disposers.length = 0
  }

  #key(capability: Capability): string {
    switch (capability.kind) {
      case "tool":
      case "agent":
      case "command":
        return capability.name
      case "hook":
        return `${capability.event}:${capability.name}`
      case "provider":
        return capability.id
    }
  }
}

export class PluginError extends Error {
  readonly _tag = "PluginError"
  constructor(message: string) {
    super(message)
    this.name = "PluginError"
  }
}

export type { ServiceDefinition }

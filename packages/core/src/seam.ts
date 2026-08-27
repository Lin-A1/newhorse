/**
 * Minimal seam container.
 *
 * Mirrors the Cordis / deepseek-harness three-part seam shape without pulling
 * in a full DI kernel. The three parts are:
 *
 *   1. Service Definition — a branded interface type plus its registry hook.
 *   2. Provider         — an implementation registered into the container.
 *   3. Consumer         — a dangling spec that reads a registered provider.
 *
 * Registration is "register → returns a disposer, revocable": calling
 * `register` stores the provider, returns a disposer, and disposing every
 * registration is teardown-able. This is deliberately synchronous and small:
 * we adopt Cordis' *semantics* (register returns a disposer, revocable, no
 * scattered type branches), not its runtime.
 */

export interface Disposer {
  (): void
}

/** Branded key identifying a service definition. */
export interface ServiceID<A> {
  readonly Service: symbol
  readonly _A: A
}

/**
 * Canonical symbol per displayName, memoized module-wide so a consumer can
 * rebuild the same ServiceID from any package. Without this, every
 * `defineService` call created a new Symbol and cross-package/plugin
 * registration would fail to resolve the same service.
 */
const IDS = new Map<string, symbol>()

function serviceSymbol(displayName: string): symbol {
  let s = IDS.get(displayName)
  if (!s) {
    s = Symbol(displayName)
    IDS.set(displayName, s)
  }
  return s
}

/**
 * A service definition: the contract both provider and consumer agree on.
 * `id` is the registry key.
 */
export interface ServiceDefinition<A> {
  readonly id: ServiceID<A>
  readonly displayName: string
}

/** Create a service definition with a stable, memoized id. */
export function defineService<A>(displayName: string): ServiceDefinition<A> {
  return { id: { Service: serviceSymbol(displayName) } as ServiceID<A>, displayName }
}

/**
 * Consumer spec: declare the services a consumer depends on by name → service
 * definition. The seam resolves them against the container at use time.
 */
export interface ConsumerSpec<T extends Record<string, unknown>> {
  readonly dependsOn: { readonly [K in keyof T]: ServiceDefinition<T[K]> }
}

/**
 * Seam container. Holds registered providers keyed by their service id and
 * resolves consumers. Pure synchronous registry — no fibre, no lifecycle
 * scheduler. That over-abstraction is what we deliberately avoid.
 */
export class Container {
  readonly #entries = new Map<symbol, unknown>()
  readonly #disposers = new Map<symbol, Disposer>()
  readonly #order: symbol[] = []
  readonly #parent: Container | undefined

  constructor(parent?: Container) {
    this.#parent = parent
  }

  /**
   * Create an isolated child scope that inherits this container's services for
   * lookup. A child can register its own providers (which shadow the parent
   * within the child's lookup) and disposing the child tears down only its own
   * registrations, leaving the parent intact. This is how per-Location and per-
   * DAG-node injection is isolated (each node gets a scope and picks its own
   * model/tools) without polluting the global registry.
   */
  scope(): Container {
    return new Container(this)
  }

  /**
   * Register a provider; returns a disposer that un-registers it.
   *
   * An optional `cleanup` runs when the registrations are disposed in reverse
   * order. Because child scopes register after their parents, disposing
   * naturally tears down children before parents.
   */
  register<A>(definition: ServiceDefinition<A>, value: A, cleanup?: () => void): Disposer {
    const key = definition.id.Service as symbol
    if (this.#entries.has(key)) {
      throw new SeamError(`service "${definition.displayName}" already registered`)
    }
    this.#entries.set(key, value)
    this.#order.push(key)
    let disposed = false
    const disposer: Disposer = () => {
      if (disposed) return
      disposed = true
      this.#entries.delete(key)
      this.#disposers.delete(key)
      const idx = this.#order.indexOf(key)
      if (idx >= 0) this.#order.splice(idx, 1)
      cleanup?.()
    }
    this.#disposers.set(key, disposer)
    return disposer
  }

  /** Read a provider, falling back to the parent scope; throws if absent. */
  get<A>(definition: ServiceDefinition<A>): A {
    if (!this.has(definition)) {
      throw new SeamError(`service "${definition.displayName}" not registered`)
    }
    return this.lookup(definition) as A
  }

  /** Try to read a provider (with parent fallback); undefined if absent. */
  getOrNull<A>(definition: ServiceDefinition<A>): A | undefined {
    return this.lookup(definition)
  }

  has(definition: ServiceDefinition<unknown>): boolean {
    const key = definition.id.Service as symbol
    if (this.#entries.has(key)) return true
    return this.#parent?.has(definition) ?? false
  }

  /** Resolve a consumer's dependencies into a plain object at use time. */
  inject<T extends Record<string, unknown>>(consumer: ConsumerSpec<T>): T {
    const out: Record<string, unknown> = {}
    for (const [name, definition] of Object.entries(consumer.dependsOn)) {
      out[name] = this.get(definition)
    }
    return out as T
  }

  /** Dispose only this scope's registrations in reverse order (parent untouched). */
  dispose(): void {
    for (let i = this.#order.length - 1; i >= 0; i--) {
      const key = this.#order[i]!
      this.#disposers.get(key)?.()
    }
    this.#entries.clear()
    this.#order.length = 0
    this.#disposers.clear()
  }

  /**
   * Look up a provider in this scope, then walk up the parent chain. A child
   * registration shadows the parent's for downstream lookups within the child.
   * Correctly distinguishes "entry exists with value undefined" from "absent".
   */
  protected lookup<A>(definition: ServiceDefinition<A>): A | undefined {
    const key = definition.id.Service as symbol
    if (this.#entries.has(key)) return this.#entries.get(key) as A
    return this.#parent?.lookup(definition)
  }
}

export class SeamError extends Error {
  readonly _tag = "SeamError"
  readonly serviceName: string
  constructor(message: string, serviceName?: string) {
    super(message)
    this.name = "SeamError"
    this.serviceName = serviceName ?? ""
  }
}

/** Convenience: define a service and its consumer in one pairing. */
export function createSeam<A>(name: string) {
  const definition = defineService<A>(name)
  return {
    definition,
    consumer<T extends Record<string, unknown>>(dependsOn: { [K in keyof T]: ServiceDefinition<T[K]> }) {
      const spec: ConsumerSpec<T> = { dependsOn }
      return { definition: spec.dependsOn, inject: <C extends Container>(c: C) => c.inject(spec) as T }
    },
  }
}

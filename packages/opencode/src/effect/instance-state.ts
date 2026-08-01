import { Effect, ScopedCache, Scope } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceMetadataRef, WorkspaceRef, type WorkspaceMetadata } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"

type CacheKey = string

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<CacheKey, A, E, R>
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID ?? (yield* WorkspaceMetadataRef)?.id
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

function encodeKey(input: { directory: string; workspaceID?: string; metadata?: WorkspaceMetadata }): CacheKey {
  return JSON.stringify([
    input.directory,
    input.workspaceID,
    input.metadata?.id,
    input.metadata?.type,
    input.metadata?.projectID,
  ])
}

function keyDirectory(key: CacheKey): string {
  return JSON.parse(key)[0]
}

const currentKey = Effect.gen(function* () {
  const ctx = yield* context
  const metadata = yield* WorkspaceMetadataRef
  return encodeKey({
    directory: ctx.directory,
    workspaceID: (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID ?? metadata?.id,
    metadata,
  })
})

const invalidateDirectory = <A, E, R>(cache: ScopedCache.ScopedCache<CacheKey, A, E, R>, directory: string) =>
  Effect.gen(function* () {
    const keys = yield* ScopedCache.keys(cache)
    yield* Effect.forEach(
      keys,
      (key) => (keyDirectory(key) === directory ? ScopedCache.invalidate(cache, key) : Effect.void),
      { discard: true },
    )
  })

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.make<CacheKey, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const off = registerDisposer((directory) => Effect.runPromise(invalidateDirectory(cache, directory)))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* currentKey)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* currentKey)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* currentKey)
  })

export * as InstanceState from "./instance-state"

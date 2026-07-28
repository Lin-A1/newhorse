import { LayerNode } from "@newhorse/core/effect/layer-node"
import path from "path"
import { createHash } from "node:crypto"
import { serviceUse } from "@newhorse/core/effect/service-use"
import { Global } from "@newhorse/core/global"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { FSUtil } from "@newhorse/core/fs-util"
import { EffectFlock } from "@newhorse/core/util/effect-flock"

export const Tokens = Schema.Struct({
  accessToken: Schema.mutableKey(Schema.String),
  refreshToken: Schema.mutableKey(Schema.optional(Schema.String)),
  expiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  scope: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Tokens = Schema.Schema.Type<typeof Tokens>

export const ClientInfo = Schema.Struct({
  clientId: Schema.mutableKey(Schema.String),
  clientSecret: Schema.mutableKey(Schema.optional(Schema.String)),
  clientIdIssuedAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  clientSecretExpiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
})
export type ClientInfo = Schema.Schema.Type<typeof ClientInfo>

export const Entry = Schema.Struct({
  tokens: Schema.mutableKey(Schema.optional(Tokens)),
  clientInfo: Schema.mutableKey(Schema.optional(ClientInfo)),
  codeVerifier: Schema.mutableKey(Schema.optional(Schema.String)),
  oauthState: Schema.mutableKey(Schema.optional(Schema.String)),
  serverUrl: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Entry = Schema.Schema.Type<typeof Entry>

const decodeAuthData = Schema.decodeUnknownOption(Schema.Record(Schema.String, Entry))
type AuthData = Record<string, Entry>

const filepath = path.join(Global.Path.data, "mcp-auth.json")
const lockKey = `mcp-auth:${filepath}`

export interface Interface {
  readonly all: () => Effect.Effect<Record<string, Entry>>
  readonly get: (mcpName: string) => Effect.Effect<Entry | undefined>
  readonly getForUrl: (mcpName: string, serverUrl: string) => Effect.Effect<Entry | undefined>
  readonly set: (mcpName: string, entry: Entry, serverUrl?: string) => Effect.Effect<void>
  readonly remove: (mcpName: string) => Effect.Effect<void>
  readonly updateTokens: (mcpName: string, tokens: Tokens, serverUrl?: string) => Effect.Effect<void>
  readonly updateClientInfo: (mcpName: string, clientInfo: ClientInfo, serverUrl?: string) => Effect.Effect<void>
  readonly updateCodeVerifier: (mcpName: string, codeVerifier: string) => Effect.Effect<void>
  readonly clearCodeVerifier: (mcpName: string) => Effect.Effect<void>
  readonly updateOAuthState: (mcpName: string, oauthState: string) => Effect.Effect<void>
  readonly getOAuthState: (mcpName: string) => Effect.Effect<string | undefined>
  readonly clearOAuthState: (mcpName: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@newhorse/McpAuth") {}

export const use = serviceUse(Service)

function scopedKey(scope: string, mcpName: string) {
  return JSON.stringify(["scope", scope, mcpName])
}

function scopedName(scope: string, key: string): string | undefined {
  try {
    const value = JSON.parse(key)
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== "scope" || value[1] !== scope) return
    return typeof value[2] === "string" ? value[2] : undefined
  } catch {
    return
  }
}

export function scope(input: { workspaceID?: string; projectID: string; directory: string }) {
  if (input.workspaceID) return `workspace:${input.workspaceID}`
  const directory = createHash("sha256").update(input.directory).digest("hex").slice(0, 16)
  return `project:${input.projectID}:${directory}`
}

export function scoped(auth: Interface, scope: string, options?: { legacy?: boolean }): Interface {
  const key = (mcpName: string) => scopedKey(scope, mcpName)
  const get = (mcpName: string) =>
    auth.get(key(mcpName)).pipe(
      Effect.flatMap((entry) => (entry || !options?.legacy ? Effect.succeed(entry) : auth.get(mcpName))),
    )
  const getForUrl = (mcpName: string, serverUrl: string) =>
    auth.getForUrl(key(mcpName), serverUrl).pipe(
      Effect.flatMap((entry) => (entry || !options?.legacy ? Effect.succeed(entry) : auth.getForUrl(mcpName, serverUrl))),
    )
  return {
    all: () =>
      Effect.map(auth.all(), (entries) => {
        const scoped = Object.fromEntries(
          Object.entries(entries).flatMap(([stored, entry]) => {
            const name = scopedName(scope, stored)
            return name ? [[name, entry]] : []
          }),
        )
        if (!options?.legacy) return scoped
        const legacy = Object.fromEntries(Object.entries(entries).filter(([stored]) => !stored.startsWith('["scope",')))
        return { ...legacy, ...scoped }
      }),
    get,
    getForUrl,
    set: (mcpName, entry, serverUrl) => auth.set(key(mcpName), entry, serverUrl),
    remove: (mcpName) =>
      auth.remove(key(mcpName)).pipe(Effect.andThen(options?.legacy ? auth.remove(mcpName) : Effect.void)),
    updateTokens: (mcpName, tokens, serverUrl) => auth.updateTokens(key(mcpName), tokens, serverUrl),
    updateClientInfo: (mcpName, clientInfo, serverUrl) => auth.updateClientInfo(key(mcpName), clientInfo, serverUrl),
    updateCodeVerifier: (mcpName, codeVerifier) => auth.updateCodeVerifier(key(mcpName), codeVerifier),
    clearCodeVerifier: (mcpName) => auth.clearCodeVerifier(key(mcpName)),
    updateOAuthState: (mcpName, oauthState) => auth.updateOAuthState(key(mcpName), oauthState),
    getOAuthState: (mcpName) => auth.getOAuthState(key(mcpName)),
    clearOAuthState: (mcpName) => auth.clearOAuthState(key(mcpName)),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service

    const read = Effect.fn("McpAuth.read")(function* () {
      return yield* fs.readJson(filepath).pipe(
        Effect.map((data): AuthData => Option.getOrElse(decodeAuthData(data), () => ({}) as AuthData) as AuthData),
        Effect.catch(() => Effect.succeed({} as AuthData)),
      )
    })

    const all = Effect.fn("McpAuth.all")(function* () {
      return yield* read().pipe(flock.withLock(lockKey), Effect.orDie)
    })

    const mutate = Effect.fn("McpAuth.mutate")(function* (update: (data: AuthData) => AuthData | undefined) {
      yield* Effect.gen(function* () {
        const next = update(yield* read())
        if (!next) return
        yield* fs.writeJson(filepath, next, 0o600).pipe(Effect.orDie)
      }).pipe(flock.withLock(lockKey), Effect.orDie)
    })

    const get = Effect.fn("McpAuth.get")(function* (mcpName: string) {
      const data = yield* all()
      return data[mcpName]
    })

    const getForUrl = Effect.fn("McpAuth.getForUrl")(function* (mcpName: string, serverUrl: string) {
      const entry = yield* get(mcpName)
      if (!entry) return undefined
      if (!entry.serverUrl) return undefined
      if (entry.serverUrl !== serverUrl) return undefined
      return entry
    })

    const set = Effect.fn("McpAuth.set")(function* (mcpName: string, entry: Entry, serverUrl?: string) {
      yield* mutate((data) => ({
        ...data,
        [mcpName]: serverUrl ? { ...entry, serverUrl } : entry,
      }))
    })

    const remove = Effect.fn("McpAuth.remove")(function* (mcpName: string) {
      yield* mutate((data) => {
        const next = { ...data }
        delete next[mcpName]
        return next
      })
    })

    const updateField = <K extends keyof Entry>(field: K, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string, value: NonNullable<Entry[K]>, serverUrl?: string) {
        yield* mutate((data) => {
          const entry = data[mcpName] ?? {}
          entry[field] = value
          if (serverUrl) entry.serverUrl = serverUrl
          return { ...data, [mcpName]: entry }
        })
      })

    const clearField = (field: keyof Entry, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string) {
        yield* mutate((data) => {
          const entry = data[mcpName]
          if (!entry) return undefined
          delete entry[field]
          return { ...data, [mcpName]: entry }
        })
      })

    const updateTokens = updateField("tokens", "updateTokens")
    const updateClientInfo = updateField("clientInfo", "updateClientInfo")
    const updateCodeVerifier = updateField("codeVerifier", "updateCodeVerifier")
    const updateOAuthState = updateField("oauthState", "updateOAuthState")
    const clearCodeVerifier = clearField("codeVerifier", "clearCodeVerifier")
    const clearOAuthState = clearField("oauthState", "clearOAuthState")

    const getOAuthState = Effect.fn("McpAuth.getOAuthState")(function* (mcpName: string) {
      const entry = yield* get(mcpName)
      return entry?.oauthState
    })

    return Service.of({
      all,
      get,
      getForUrl,
      set,
      remove,
      updateTokens,
      updateClientInfo,
      updateCodeVerifier,
      clearCodeVerifier,
      updateOAuthState,
      getOAuthState,
      clearOAuthState,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, EffectFlock.node] })

export * as McpAuth from "./auth"

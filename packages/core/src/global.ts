import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"

const app = "newhorse"
const legacyApp = "opencode"

async function selectDirectory(root: string, fallback: string, name: string) {
  const current = path.join(root, name)
  const legacy = path.join(root, fallback)
  const [hasCurrent, hasLegacy] = await Promise.all([
    fs
      .stat(current)
      .then(() => true)
      .catch(() => false),
    fs
      .stat(legacy)
      .then(() => true)
      .catch(() => false),
  ])
  // Existing installs keep using their legacy directory in place. New installs
  // use newhorse, and once a newhorse directory exists it takes precedence.
  return hasCurrent || !hasLegacy ? current : legacy
}

const [data, cache, config, state] = await Promise.all([
  selectDirectory(xdgData!, legacyApp, app),
  selectDirectory(xdgCache!, legacyApp, app),
  selectDirectory(xdgConfig!, legacyApp, app),
  selectDirectory(xdgState!, legacyApp, app),
])
const tmp = path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return process.env.NH_TEST_HOME ?? process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@newhorse/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.OPENCODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"

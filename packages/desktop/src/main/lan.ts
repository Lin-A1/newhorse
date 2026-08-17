import { networkInterfaces } from "node:os"

import { getStore } from "./store"
import { LAN_ENABLED_KEY, LAN_PASSWORD_KEY, LAN_PORT_KEY } from "./store-keys"

export type LanConfig = {
  enabled: boolean
  password: string | null
  port: number | null
  token: string | null
}

export function getLanConfig(): LanConfig {
  const store = getStore()
  const enabled = store.get(LAN_ENABLED_KEY) === "true"
  const password = store.get(LAN_PASSWORD_KEY)
  const rawPort = store.get(LAN_PORT_KEY)
  const port = typeof rawPort === "string" && /^\d+$/.test(rawPort) ? Number.parseInt(rawPort, 10) : null
  const resolvedPassword = typeof password === "string" && password.length > 0 ? password : null
  return {
    enabled,
    password: resolvedPassword,
    port: port && port > 0 ? port : null,
    token: resolvedPassword ? authToken(resolvedPassword) : null,
  }
}

export function getLanReady() {
  const config = getLanConfig()
  return config.enabled && Boolean(config.password)
}

export function saveLanConfig(partial: Partial<{ enabled: boolean; password: string | null; port: number | null }>) {
  const store = getStore()
  if (partial.enabled !== undefined) {
    if (partial.enabled) store.set(LAN_ENABLED_KEY, "true")
    else store.delete(LAN_ENABLED_KEY)
  }
  if (partial.password !== undefined) {
    if (partial.password) store.set(LAN_PASSWORD_KEY, partial.password)
    else store.delete(LAN_PASSWORD_KEY)
  }
  if (partial.port !== undefined) {
    if (partial.port) store.set(LAN_PORT_KEY, String(partial.port))
    else store.delete(LAN_PORT_KEY)
  }
}

export function authToken(password: string) {
  return Buffer.from(`opencode:${password}`).toString("base64")
}

export function getNetworkIPs(): string[] {
  const results: string[] = []
  for (const name of Object.keys(networkInterfaces())) {
    const net = networkInterfaces()[name]
    if (!net) continue
    for (const info of net) {
      if (info.internal || info.family !== "IPv4") continue
      if (info.address.startsWith("172.")) continue
      results.push(info.address)
    }
  }
  return results
}

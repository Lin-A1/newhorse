import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { networkInterfaces } from "node:os"

import { getStore } from "./store"
import { LAN_ENABLED_KEY, LAN_PASSWORD_KEY, LAN_PORT_KEY } from "./store-keys"

const execFileAsync = promisify(execFile)

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

// Candidate subnets for a *reachable* LAN URL. Anything not on this list
// (link-local 169.254.x, CGNAT 100.64.x, common VPN/TUN ranges like 198.18.x
// and 172.16-31.x) is skipped so the settings panel only offers addresses a
// phone on the same Wi-Fi can actually open.
function isRoutableLanIPv4(address: string): boolean {
  const octets = address.split(".").map(Number)
  if (octets.length !== 4) return false
  const [a, b] = octets
  if (a === 169 && b === 254) return false // link-local APIPA
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 172 && b >= 16 && b <= 31) return false // private VPN/Docker
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking (Clash TUN)
  if (a === 10) return false // large private (often VPN)
  return true
}

export function getNetworkIPs(): string[] {
  const results: string[] = []
  for (const name of Object.keys(networkInterfaces())) {
    const net = networkInterfaces()[name]
    if (!net) continue
    for (const info of net) {
      if (info.internal || info.family !== "IPv4") continue
      if (!isRoutableLanIPv4(info.address)) continue
      results.push(info.address)
    }
  }
  return results
}

export type FirewallRuleStatus = "added" | "exists" | "skipped" | "failed"

const FIREWALL_RULE_NAME = "newhorse LAN access"

// Add a Windows Firewall inbound rule so the LAN port is reachable from
// another device without an interactive "Allow" prompt. Best-effort: failure
// surfaces to the caller so the UI can explain that the user may need to run
// the command themselves.
export async function ensureFirewallRule(port: number): Promise<FirewallRuleStatus> {
  if (process.platform !== "win32") return "skipped"
  const rule = `name="${FIREWALL_RULE_NAME}"`
  const program = process.execPath
  const filter = `${rule} dir=in action=allow program="${program}" protocol=TCP localport=${port}`
  try {
    await execFileAsync("netsh", ["advfirewall", "firewall", "delete", "rule", rule], { windowsHide: true })
  } catch {
    // Rule did not exist; nothing to delete.
  }
  try {
    await execFileAsync("netsh", ["advfirewall", "firewall", "add", "rule", ...filter.split(" ")], {
      windowsHide: true,
    })
    return "added"
  } catch (error) {
    return "failed"
  }
}

export async function removeFirewallRule(): Promise<void> {
  if (process.platform !== "win32") return
  try {
    await execFileAsync(
      "netsh",
      ["advfirewall", "firewall", "delete", "rule", `name="${FIREWALL_RULE_NAME}"`],
      { windowsHide: true },
    )
  } catch {
    // Nothing to delete.
  }
}

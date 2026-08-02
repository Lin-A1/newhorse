#!/usr/bin/env bun
/**
 * Unified Newhorse product orchestrator.
 *
 * One entry point for target inspection, doctor checks, Web startup, development,
 * cross-platform CLI/Desktop builds and exports, and artifact verification.
 *
 *   bun run product targets [--json]
 *   bun run product doctor [--target <id> ...]
 *   bun run product web [--source]
 *   bun run product dev <web|desktop|tui|cli>
 *   bun run product build [--product cli|desktop|all] [--target <id>]
 *   bun run product export [--product cli|desktop|all] [--target <id>] [--execution local|ci|auto]
 *   bun run product verify --artifact <path>
 *
 * The orchestrator only delegates to existing package scripts (CLI build/export,
 * desktop electron-builder, `nh web`). It never re-implements bundling or packaging.
 */

import { $ } from "bun"
import { argv, platform as hostPlatformName, arch as hostArchName } from "node:process"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const PKG = {
  opencode: path.join(ROOT, "packages/opencode"),
  desktop: path.join(ROOT, "packages/desktop"),
  app: path.join(ROOT, "packages/app"),
}

export type ExecutionMode = "local" | "ci" | "auto"

export type CliTarget = {
  id: string
  os: "linux" | "windows" | "macos"
  arch: "x64" | "arm64"
  abi: "glibc" | "musl"
  cpuTier: "avx2" | "baseline"
}

export type DesktopTarget = {
  id: string
  os: "linux" | "windows" | "macos"
  packageCommand: string
  formats: string[]
}

/** Mirrors packages/opencode/script/build.ts `validTargetIDs`. */
export const CLI_TARGETS: CliTarget[] = [
  { id: "linux-arm64", os: "linux", arch: "arm64", abi: "glibc", cpuTier: "avx2" },
  { id: "linux-x64", os: "linux", arch: "x64", abi: "glibc", cpuTier: "avx2" },
  { id: "linux-x64-baseline", os: "linux", arch: "x64", abi: "glibc", cpuTier: "baseline" },
  { id: "linux-arm64-musl", os: "linux", arch: "arm64", abi: "musl", cpuTier: "avx2" },
  { id: "linux-x64-musl", os: "linux", arch: "x64", abi: "musl", cpuTier: "avx2" },
  { id: "linux-x64-baseline-musl", os: "linux", arch: "x64", abi: "musl", cpuTier: "baseline" },
  { id: "darwin-arm64", os: "macos", arch: "arm64", abi: "glibc", cpuTier: "avx2" },
  { id: "darwin-x64", os: "macos", arch: "x64", abi: "glibc", cpuTier: "avx2" },
  { id: "darwin-x64-baseline", os: "macos", arch: "x64", abi: "glibc", cpuTier: "baseline" },
  { id: "windows-arm64", os: "windows", arch: "arm64", abi: "glibc", cpuTier: "avx2" },
  { id: "windows-x64", os: "windows", arch: "x64", abi: "glibc", cpuTier: "avx2" },
  { id: "windows-x64-baseline", os: "windows", arch: "x64", abi: "glibc", cpuTier: "baseline" },
]

/**
 * CLI targets with a complete local portable export contract
 * (packages/opencode/script/export-local.ts TARGETS). Everything else in
 * CLI_TARGETS is configured-only until an exporter and target-OS runtime
 * verification exist.
 */
export const EXPORTABLE_CLI_TARGETS = new Set(["linux-x64", "windows-x64", "windows-x64-baseline"])

/**
 * Targets with runtime verification evidence on a target OS runner (CI or local).
 * This must stay conservative: a target is only "verified" when a real runner
 * executed the artifact, not merely because the compiler can emit it.
 *
 * linux-x64 was runtime-verified on this Linux host (2026-08-02): the exported
 * binary answered `nh --version` -> 1.18.4 and `nh setup profile --help`, and
 * the export-cli `validate-linux` job repeated the check on an ubuntu runner.
 * windows-x64 and windows-x64-baseline were runtime-verified on windows-latest
 * runners via the export-cli `validate-windows` job (2026-08-02): nh.exe answered
 * the expected version and setup profile --help.
 */
export const VERIFIED_CLI_TARGETS = new Set(["linux-x64", "windows-x64", "windows-x64-baseline"])

export const DESKTOP_TARGETS: DesktopTarget[] = [
  { id: "desktop-linux", os: "linux", packageCommand: "package:linux", formats: ["AppImage", "DEB", "RPM"] },
  { id: "desktop-windows", os: "windows", packageCommand: "package:win", formats: ["NSIS"] },
  { id: "desktop-macos", os: "macos", packageCommand: "package:mac", formats: ["DMG", "ZIP"] },
]

/** Desktop packaging must run on the target OS; no local cross-packaging promise. */
export const VERIFIED_DESKTOP_TARGETS = new Set<string>()

export type TargetStatus = {
  id: string
  kind: "cli" | "desktop" | "web"
  os: string
  arch?: string
  configured: boolean
  exportable: boolean
  verified: boolean
  signed: boolean
  releasable: boolean
  requiredHost?: string
  packageFormats?: string[]
  note?: string
}

export function host(): { os: string; arch: string } {
  const os = hostPlatformName === "darwin" ? "macos" : hostPlatformName === "win32" ? "windows" : "linux"
  return { os, arch: hostArchName }
}

export function targetStatuses(): TargetStatus[] {
  const { os: hostOS, arch: hostCPU } = host()
  const statuses: TargetStatus[] = []

  for (const target of CLI_TARGETS) {
    const exportable = EXPORTABLE_CLI_TARGETS.has(target.id)
    const verified = VERIFIED_CLI_TARGETS.has(target.id)
    statuses.push({
      id: target.id,
      kind: "cli",
      os: target.os,
      arch: target.arch,
      configured: true,
      exportable,
      verified,
      signed: false,
      releasable: verified && false,
      requiredHost: target.os,
      note: exportable
        ? "portable ZIP + sha256 + manifest"
        : verified
          ? "runtime-verified on target OS runner"
          : "configured-only; no local export contract yet",
    })
  }

  for (const target of DESKTOP_TARGETS) {
    const verified = VERIFIED_DESKTOP_TARGETS.has(target.id)
    statuses.push({
      id: target.id,
      kind: "desktop",
      os: target.os,
      configured: true,
      exportable: true,
      verified,
      signed: false,
      releasable: verified && false,
      requiredHost: target.os,
      packageFormats: target.formats,
      note:
        target.os === "windows"
          ? "NSIS installer built on a windows runner via export-desktop (2026-08-02); Azure Trusted Signing is opt-in via secrets, otherwise unsigned; Windows portable is unsupported (unpacked dir is not portable); runtime smoke pending"
          : target.os === "macos"
            ? "DMG/ZIP built on a macos runner via export-desktop (2026-08-02); Developer ID + notarization are opt-in via APPLE_* secrets, otherwise unsigned"
              : "AppImage/DEB/RPM built on a ubuntu runner via export-desktop (2026-08-02); runtime smoke pending",
    })
  }

  statuses.push({
    id: "web",
    kind: "web",
    os: "any",
    configured: true,
    exportable: true,
    verified: false,
    signed: false,
    releasable: false,
    requiredHost: "any",
    note: "product web entry via `nh web`; packages/app dev is a backend-required HMR UI",
  })
  return statuses
}

export function resolveTargets(kind: "cli" | "desktop", requested?: string[]): string[] {
  const all = (kind === "cli" ? CLI_TARGETS : DESKTOP_TARGETS).map((item) => item.id)
  if (!requested || requested.length === 0) return all
  const known = new Set(all)
  for (const id of requested) if (!known.has(id)) throw new Error(`Unknown ${kind} target: ${id}`)
  return requested
}

function isHostCompatible(targetOs: string): boolean {
  if (targetOs === "any") return true
  return targetOs === host().os
}

const CACHE_FILE = path.join(ROOT, "packages/opencode/dist/exports", ".product-cache.json")

type CacheEntry = {
  fingerprint: string
  artifacts: string[]
  builtAt: string
}

type ProductCache = Record<string, CacheEntry>

const CLI_INPUT_GLOBS = [
  "packages/opencode/src/**/*",
  "packages/opencode/script/**/*",
  "packages/app/src/**/*",
  "packages/app/package.json",
  "packages/opencode/package.json",
  "package.json",
  "bun.lock",
]

const DESKTOP_INPUT_GLOBS = [
  "packages/desktop/src/**/*",
  "packages/desktop/electron-builder.config.ts",
  "packages/desktop/package.json",
  ...CLI_INPUT_GLOBS,
]

async function hashInputs(globs: string[]) {
  const hasher = new Bun.CryptoHasher("sha256")
  const files = new Set<string>()
  for (const glob of globs) {
    for await (const match of new Bun.Glob(glob).scan({ cwd: ROOT, onlyFiles: true })) {
      files.add(match)
    }
  }
  for (const rel of [...files].sort()) {
    const file = Bun.file(path.join(ROOT, rel))
    if (await file.exists()) {
      hasher.update(rel)
      hasher.update(await file.arrayBuffer())
    }
  }
  return hasher.digest("hex")
}

async function readCache(): Promise<ProductCache> {
  const file = Bun.file(CACHE_FILE)
  if (!(await file.exists())) return {}
  try {
    return JSON.parse(await file.text()) as ProductCache
  } catch {
    return {}
  }
}

async function writeCache(cache: ProductCache) {
  await Bun.write(CACHE_FILE, JSON.stringify(cache, null, 2))
}

function cliArtifactPaths(target: string, version: string) {
  return [
    `packages/opencode/dist/exports/newhorse-${target}-v${version}.zip`,
    `packages/opencode/dist/exports/newhorse-${target}-v${version}.zip.sha256`,
    `packages/opencode/dist/exports/newhorse-${target}-v${version}.manifest.json`,
  ]
}

async function cacheHit(entry: CacheEntry | undefined, fingerprint: string, artifacts: string[]) {
  if (!entry || entry.fingerprint !== fingerprint) return false
  for (const artifact of artifacts) {
    if (!(await Bun.file(path.join(ROOT, artifact)).exists())) return false
  }
  return true
}

async function cliFingerprint(target: string, version: string) {
  const bunVersion = (await Bun.$`bun --version`.text()).trim()
  const inputs = await hashInputs(CLI_INPUT_GLOBS)
  return `${inputs}:${target}:${version}:${bunVersion}`
}

async function desktopFingerprint(target: string) {
  const bunVersion = (await Bun.$`bun --version`.text()).trim()
  const inputs = await hashInputs(DESKTOP_INPUT_GLOBS)
  return `${inputs}:${target}:${bunVersion}`
}

async function run(command: string[], cwdPath: string, inherit = true) {
  console.log(`\n$ ${command.join(" ")}  (cwd=${path.relative(ROOT, cwdPath) || "."})`)
  const proc = Bun.spawn(command, { cwd: cwdPath, stdout: inherit ? "inherit" : "pipe", stderr: inherit ? "inherit" : "pipe" })
  const exit = await proc.exited
  if (exit !== 0) throw new Error(`Command failed (exit ${exit}): ${command.join(" ")}`)
  return exit
}

function printStatuses(statuses: TargetStatus[], json = false) {
  if (json) {
    console.log(JSON.stringify(statuses, null, 2))
    return
  }
  const pad = (value: string, width: number) => value.padEnd(width)
  console.log(pad("id", 28) + pad("kind", 10) + pad("os", 12) + pad("arch", 8) + pad("exp", 4) + pad("ver", 4) + "note")
  for (const status of statuses) {
    console.log(
      pad(status.id, 28) +
        pad(status.kind, 10) +
        pad(status.os, 12) +
        pad(status.arch ?? "-", 8) +
        pad(status.exportable ? "yes" : "no", 4) +
        pad(status.verified ? "yes" : "no", 4) +
        (status.note ?? ""),
    )
  }
}

function parseFlags(args: string[]) {
  const flags = new Set<string>()
  const keyed = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith("--")) {
      const value = args[i + 1]
      if (value && !value.startsWith("--")) {
        keyed.set(arg, value)
        i += 1
      } else {
        flags.add(arg)
      }
    }
  }
  return { flags, keyed }
}

const command = argv[2]
const rest = argv.slice(3)
const { flags, keyed } = parseFlags(rest)

async function main() {
  switch (command) {
    case "targets": {
      const statuses = targetStatuses()
      printStatuses(statuses, flags.has("--json"))
      return
    }
    case "doctor": {
      const { os, arch } = host()
      console.log(`host: ${os}/${arch}`)
      const bun = (await Bun.$`bun --version`.text()).trim()
      console.log(`bun: ${bun}`)
      const requestedTargets = keyed.get("--target")
      const statuses = targetStatuses().filter(
        (item) => !requestedTargets || item.id === requestedTargets,
      )
      for (const status of statuses) {
        const ok = status.verified && isHostCompatible(status.os)
        console.log(`${ok ? "ok  " : "warn"} ${status.id} (${status.note ?? ""})`)
        if (status.exportable && !status.verified) {
          console.log(`     not runtime-verified: needs ${status.requiredHost} runner`)
        }
      }
      const unverified = statuses.filter((status) => status.exportable && !status.verified)
      if (unverified.length > 0) {
        console.log("\nActions to unblock (run on a suitable host):")
        if (statuses.some((status) => status.id === "desktop-linux" && !status.verified)) {
          console.log("  desktop-linux RPM:  sudo apt-get install -y rpm")
        }
        if (statuses.some((status) => status.id === "desktop-windows" && !status.verified)) {
          console.log("  desktop-windows:    build on a Windows host, or install wine on Linux for cross-build")
        }
        if (statuses.some((status) => status.os === "macos" && !status.verified)) {
          console.log("  desktop-macos:      build and sign on a macOS host with notarization credentials")
        }
        console.log("  runtime verification: run `bun run product verify` on the target-OS runner for each artifact")
        console.log("  CI path (CLI):        run the `export-cli` workflow (workflow_dispatch, target=linux-x64|windows-x64|windows-x64-baseline) — validate-linux/validate-windows runtime-check the artifact on a target-OS runner")
        console.log("  CI path (Desktop):    run the `export-desktop` workflow (workflow_dispatch) for Linux RPM / Windows NSIS / macOS DMG+ZIP installers; macOS signing needs notarization credentials")
      }
      return
    }
    case "web": {
      await run(["bun", "run", "--conditions=browser", "./src/index.ts", "web"], PKG.opencode)
      return
    }
    case "dev": {
      const mode = rest[0]
      if (mode === "cli") {
        await run(["bun", "run", "--conditions=browser", "./src/index.ts"], PKG.opencode)
      } else if (mode === "web") {
        await run(["bun", "run", "dev"], PKG.app)
      } else if (mode === "desktop") {
        await run(["bun", "run", "dev"], PKG.desktop)
      } else {
        throw new Error(`Unknown dev mode: ${mode} (expected cli|web|desktop)`)
      }
      return
    }
    case "build": {
      const product = keyed.get("--product") ?? "all"
      const targets = keyed.get("--target")
      if (product === "cli" || product === "all") {
        const ids = resolveTargets("cli", targets ? [targets] : undefined)
        for (const id of ids) await run(["bun", "run", "script/build.ts", "--target", id], PKG.opencode)
      }
      if (product === "desktop" || product === "all") {
        await run(["bun", "run", "build"], PKG.desktop)
      }
      return
    }
    case "export": {
      const product = keyed.get("--product") ?? "all"
      const execution = (keyed.get("--execution") ?? "local") as ExecutionMode
      const force = flags.has("--force")
      if (!["local", "ci", "auto"].includes(execution)) throw new Error(`Unknown --execution: ${execution}`)
      const cache = await readCache()
      if (product === "cli" || product === "all") {
        const targets = keyed.get("--target")
        const ids = resolveTargets("cli", targets ? [targets] : undefined)
        for (const id of ids) {
          const target = CLI_TARGETS.find((item) => item.id === id)!
          if (!EXPORTABLE_CLI_TARGETS.has(id)) {
            console.log(`skip ${id}: no local export contract yet`)
            continue
          }
          if (execution === "local" && !isHostCompatible(target.os)) {
            console.log(`skip ${id}: requires a ${target.os} host for runtime verification (cross-compile only under --execution auto/ci)`)
            continue
          }
          const version =
            keyed.get("--version") ??
            process.env.OPENCODE_VERSION ??
            (await Bun.file(path.join(PKG.opencode, "package.json")).json()).version
          const fingerprint = await cliFingerprint(id, version)
          const artifacts = cliArtifactPaths(id, version)
          if (!force && (await cacheHit(cache[id], fingerprint, artifacts))) {
            console.log(`cached ${id} (inputs unchanged): ${artifacts[0]}`)
            continue
          }
          await run(["bun", "run", "export:local", "--target", id, "--version", version], PKG.opencode)
          cache[id] = { fingerprint, artifacts, builtAt: new Date().toISOString() }
          await writeCache(cache)
        }
      }
      if (product === "desktop" || product === "all") {
        const targets = keyed.get("--target")
        const ids = resolveTargets("desktop", targets ? [targets] : undefined)
        for (const id of ids) {
          const target = DESKTOP_TARGETS.find((item) => item.id === id)!
          if (execution === "local" && !isHostCompatible(target.os)) {
            console.log(`skip ${id}: desktop packaging requires a ${target.os} host (use --execution ci/auto)`)
            continue
          }
          const fingerprint = await desktopFingerprint(id)
          const outDir = path.join(ROOT, "packages/desktop/release")
          const exists = await Bun.file(outDir).exists()
          if (!force && (await cacheHit(cache[id], fingerprint, [outDir])) && exists) {
            console.log(`cached ${id} (inputs unchanged): ${outDir}`)
            continue
          }
          await run(["bun", "run", target.packageCommand], PKG.desktop)
          cache[id] = { fingerprint, artifacts: [outDir], builtAt: new Date().toISOString() }
          await writeCache(cache)
        }
      }
      return
    }
    case "verify": {
      const artifact = keyed.get("--artifact")
      if (!artifact) throw new Error("verify requires --artifact <path>")
      const absolute = path.resolve(ROOT, artifact)
      const file = Bun.file(absolute)
      if (!(await file.exists())) throw new Error(`Artifact not found: ${absolute}`)
      const data = new Uint8Array(await file.arrayBuffer())
      const size = (await file.stat()).size
      const hasher = new Bun.CryptoHasher("sha256")
      hasher.update(data)
      const digest = hasher.digest("hex")
      console.log(`artifact: ${absolute}`)
      console.log(`size: ${size} bytes`)
      console.log(`sha256: ${digest}`)
      if (artifact.endsWith(".zip")) {
        const checksumPath = `${absolute}.sha256`
        const checksumFile = Bun.file(checksumPath)
        if (await checksumFile.exists()) {
          const expected = (await checksumFile.text()).trim().split(/\s+/)[0]
          if (expected === digest) {
            console.log("checksum: matches <artifact>.sha256")
          } else {
            throw new Error(`checksum mismatch: expected ${expected}, got ${digest}`)
          }
        }
        if (data.length > 4 && data[0] === 0x50 && data[1] === 0x4b) {
          console.log("archive: ZIP header present (structure/format were validated at export time)")
        }
      }
      console.log("Static verification passed. Run the artifact on the target OS runner for runtime smoke.")
      return
    }
    case "--help":
    case "help":
    default: {
      console.log(
        `Newhorse product orchestrator

Usage:
  bun run product targets [--json]        List every target and its status
  bun run product doctor [--target <id>]   Check host and target readiness
  bun run product web [--source]           Start the product Web entry (nh web)
  bun run product dev <cli|web|desktop>    Run a development host
  bun run product build [--product cli|desktop|all] [--target <id>]
  bun run product export [--product cli|desktop|all] [--target <id>] [--execution local|ci|auto]
  bun run product verify --artifact <path>

Status meanings:
  configured  code/config exist          exportable  local or CI export path exists
  verified    ran on a target-OS runner  signed      code-signed / notarized
  releasable  verified AND signed AND authorized

CLI portable export targets: linux-x64, windows-x64, windows-x64-baseline
Desktop: desktop-linux (AppImage/DEB/RPM), desktop-windows (NSIS), desktop-macos (DMG/ZIP).
Windows desktop portable is unsupported; unpacked Electron dirs are not portable artifacts.
`,
      )
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

#!/usr/bin/env bun

import path from "path"
import { mkdir, rename, rm } from "node:fs/promises"
import { parseArgs } from "node:util"
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js"
import pkg from "../package.json"

export const TARGETS = {
  "linux-x64": { directory: "newhorse-linux-x64", binary: "nh", format: "elf" },
  "windows-x64": { directory: "newhorse-windows-x64", binary: "nh.exe", format: "pe" },
  "windows-x64-baseline": {
    directory: "newhorse-windows-x64-baseline",
    binary: "nh.exe",
    format: "pe",
  },
} as const

export type ExportTarget = keyof typeof TARGETS

export function parseExportArgs(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      target: { type: "string", short: "t", default: "windows-x64" },
      version: { type: "string", short: "v", default: pkg.version },
      "skip-install": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  }).values
  if (!(parsed.target in TARGETS)) throw new Error(`Unsupported target: ${parsed.target}`)
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(parsed.version)) throw new Error(`Invalid version: ${parsed.version}`)
  return {
    target: parsed.target as ExportTarget,
    version: parsed.version,
    skipInstall: parsed["skip-install"],
    help: parsed.help,
  }
}

export function exportEnvironment(input: NodeJS.ProcessEnv, version: string) {
  const env: Record<string, string | undefined> = {
    ...input,
    OPENCODE_VERSION: version,
    OPENCODE_CHANNEL: input.OPENCODE_CHANNEL ?? "dev",
  }
  delete env.OPENCODE_RELEASE
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.GH_REPO
  return env
}

export function artifactNames(target: ExportTarget, version: string) {
  const stem = `newhorse-${target}-v${version}`
  return {
    archive: `${stem}.zip`,
    checksum: `${stem}.zip.sha256`,
    manifest: `${stem}.manifest.json`,
  }
}

export function validateBinary(target: ExportTarget, data: Uint8Array) {
  const metadata = TARGETS[target]
  if (metadata.format === "elf") {
    if (data.length < 4 || data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) {
      throw new Error("Expected an ELF binary")
    }
    return
  }
  if (data.length < 0x40 || data[0] !== 0x4d || data[1] !== 0x5a) throw new Error("Expected an MZ executable")
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const offset = view.getUint32(0x3c, true)
  if (offset + 6 > data.length) throw new Error("Invalid PE header offset")
  if (
    data[offset] !== 0x50 ||
    data[offset + 1] !== 0x45 ||
    data[offset + 2] !== 0 ||
    data[offset + 3] !== 0
  ) {
    throw new Error("Expected a PE executable")
  }
  if (view.getUint16(offset + 4, true) !== 0x8664) throw new Error("Expected an AMD64 PE executable")
}

export function sha256(data: Uint8Array) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(data)
  return hasher.digest("hex")
}

export async function createArchive(name: string, data: Uint8Array) {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add(name, new Uint8ArrayReader(data))
  return writer.close()
}

export async function readArchive(data: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(data))
  try {
    const entries = await reader.getEntries()
    const files = entries.filter((entry) => !entry.directory)
    if (entries.length !== 1 || files.length !== 1 || !files[0].getData) {
      throw new Error("Archive must contain exactly one file")
    }
    if (files[0].filename.includes("/") || files[0].filename.includes("\\")) {
      throw new Error("Archive file must be at the root")
    }
    return { name: files[0].filename, data: await files[0].getData(new Uint8ArrayWriter()) }
  } finally {
    await reader.close()
  }
}

export function createManifest(input: {
  target: ExportTarget
  version: string
  binaryName: string
  binary: Uint8Array
  binarySha256?: string
  archiveName: string
  archive: Uint8Array
  archiveSha256?: string
}) {
  return {
    formatVersion: 1,
    product: "newhorse",
    target: input.target,
    version: input.version,
    binary: {
      name: input.binaryName,
      size: input.binary.length,
      sha256: input.binarySha256 ?? sha256(input.binary),
    },
    archive: {
      name: input.archiveName,
      size: input.archive.length,
      sha256: input.archiveSha256 ?? sha256(input.archive),
    },
  }
}

export function help() {
  return `Usage: bun run export:local [options]\n\nOptions:\n  -t, --target <target>  ${Object.keys(TARGETS).join(" | ")}\n  -v, --version <value>  Package version (default: ${pkg.version})\n      --skip-install     Skip cross-target native dependency installation\n  -h, --help             Show help\n`
}

export async function main(args: string[]) {
  const options = parseExportArgs(args)
  if (options.help) {
    process.stdout.write(help())
    return
  }

  const packageDir = path.resolve(import.meta.dir, "..")
  const metadata = TARGETS[options.target]
  const command = ["bun", "run", "script/build.ts", "--target", options.target]
  if (options.skipInstall) command.push("--skip-install")
  const proc = Bun.spawn(command, {
    cwd: packageDir,
    env: exportEnvironment(process.env, options.version),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`Build failed with exit code ${code}`)

  const binaryPath = path.join(packageDir, "dist", metadata.directory, "bin", metadata.binary)
  const binary = new Uint8Array(await Bun.file(binaryPath).arrayBuffer())
  validateBinary(options.target, binary)

  const names = artifactNames(options.target, options.version)
  const binarySha256 = sha256(binary)
  const archive = await createArchive(metadata.binary, binary)
  const archiveSha256 = sha256(archive)
  const manifest = createManifest({
    target: options.target,
    version: options.version,
    binaryName: metadata.binary,
    binary,
    binarySha256,
    archiveName: names.archive,
    archive,
    archiveSha256,
  })

  const output = path.join(packageDir, "dist", "exports")
  await mkdir(output, { recursive: true })
  const archivePath = path.join(output, names.archive)
  const checksumPath = path.join(output, names.checksum)
  const manifestPath = path.join(output, names.manifest)
  const temporary = [archivePath, checksumPath, manifestPath].map((file) => `${file}.${process.pid}.tmp`)
  try {
    await Bun.write(temporary[0], archive)
    const written = new Uint8Array(await Bun.file(temporary[0]).arrayBuffer())
    const verified = await readArchive(written)
    if (
      sha256(written) !== archiveSha256 ||
      verified.name !== metadata.binary ||
      sha256(verified.data) !== binarySha256
    ) {
      throw new Error("Written archive verification failed")
    }

    await Bun.write(temporary[1], `${archiveSha256}  ${names.archive}\n`)
    await Bun.write(temporary[2], JSON.stringify(manifest, null, 2) + "\n")
    for (const file of [archivePath, checksumPath, manifestPath]) await rm(file, { force: true })
    await rename(temporary[0], archivePath)
    await rename(temporary[1], checksumPath)
    await rename(temporary[2], manifestPath)
  } finally {
    await Promise.all(temporary.map((file) => rm(file, { force: true })))
  }

  process.stdout.write(
    JSON.stringify(
      {
        binary: binaryPath,
        archive: archivePath,
        checksum: checksumPath,
        manifest: manifestPath,
        sha256: archiveSha256,
      },
      null,
      2,
    ) + "\n",
  )
}

if (import.meta.main) {
  await main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}

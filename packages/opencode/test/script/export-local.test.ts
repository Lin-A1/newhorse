import { describe, expect, test } from "bun:test"
import {
  artifactNames,
  createArchive,
  createManifest,
  exportEnvironment,
  parseExportArgs,
  readArchive,
  sha256,
  validateBinary,
} from "../../script/export-local"

function pe(machine = 0x8664) {
  const data = new Uint8Array(128)
  data[0] = 0x4d
  data[1] = 0x5a
  new DataView(data.buffer).setUint32(0x3c, 64, true)
  data.set([0x50, 0x45, 0, 0], 64)
  new DataView(data.buffer).setUint16(68, machine, true)
  return data
}

describe("local CLI exporter", () => {
  test("parses deterministic defaults and supported targets", () => {
    expect(parseExportArgs([])).toMatchObject({ target: "windows-x64", version: "1.18.4", skipInstall: false })
    expect(
      parseExportArgs(["--target", "linux-x64", "--version", "1.18.4-phase6.20260727", "--skip-install"]),
    ).toMatchObject({ target: "linux-x64", version: "1.18.4-phase6.20260727", skipInstall: true })
    expect(() => parseExportArgs(["--target", "darwin-x64"])).toThrow("Unsupported target")
    expect(() => parseExportArgs(["--version", "bad version"])).toThrow("Invalid version")
  })

  test("removes every release and GitHub publication variable", () => {
    const env = exportEnvironment(
      {
        PATH: "/bin",
        OPENCODE_RELEASE: "false",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        GH_REPO: "owner/repo",
      },
      "2.0.0",
    )
    expect(env).toMatchObject({ PATH: "/bin", OPENCODE_VERSION: "2.0.0", OPENCODE_CHANNEL: "dev" })
    expect(env.OPENCODE_RELEASE).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_REPO).toBeUndefined()
  })

  test("validates ELF and AMD64 PE binaries", () => {
    expect(() => validateBinary("linux-x64", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).not.toThrow()
    expect(() => validateBinary("linux-x64", Uint8Array.from([0x4d, 0x5a]))).toThrow("ELF")
    expect(() => validateBinary("windows-x64", pe())).not.toThrow()
    expect(() => validateBinary("windows-x64-baseline", pe())).not.toThrow()
    expect(() => validateBinary("windows-x64", pe(0x14c))).toThrow("AMD64")
    expect(() => validateBinary("windows-x64", Uint8Array.from([0x4d, 0x5a]))).toThrow("MZ")
  })

  test("creates and verifies a single root archive entry", async () => {
    const binary = pe()
    const archive = await createArchive("nh.exe", binary)
    const extracted = await readArchive(archive)
    expect(extracted.name).toBe("nh.exe")
    expect(sha256(extracted.data)).toBe(sha256(binary))
  })

  test("builds stable names and a consistent manifest", async () => {
    const binary = pe()
    const archive = await createArchive("nh.exe", binary)
    const names = artifactNames("windows-x64", "1.18.4-phase6.20260727")
    expect(names).toEqual({
      archive: "newhorse-windows-x64-v1.18.4-phase6.20260727.zip",
      checksum: "newhorse-windows-x64-v1.18.4-phase6.20260727.zip.sha256",
      manifest: "newhorse-windows-x64-v1.18.4-phase6.20260727.manifest.json",
    })
    expect(
      createManifest({
        target: "windows-x64",
        version: "1.18.4-phase6.20260727",
        binaryName: "nh.exe",
        binary,
        archiveName: names.archive,
        archive,
      }),
    ).toEqual({
      formatVersion: 1,
      product: "newhorse",
      target: "windows-x64",
      version: "1.18.4-phase6.20260727",
      binary: { name: "nh.exe", size: binary.length, sha256: sha256(binary) },
      archive: { name: names.archive, size: archive.length, sha256: sha256(archive) },
    })
  })
})

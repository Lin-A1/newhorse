import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { join, dirname } from "node:path"
import { mkdir, writeFile, readFile, stat } from "node:fs/promises"

/**
 * Content-addressed attachment store (docs/agent-runtime-integrations.md §5,
 * wave 1). The log stores `sha256` REFERENCES; the bytes live here, once,
 * immutable and deduplicated by content. Re-putting the same bytes is an
 * idempotent no-op. v1 has no GC (audit-first: an attachment outlives every
 * event that references it) and no transcoding (an encoder would be a plugin
 * seam; client-side discipline lives in the host's image guidance).
 */

export interface StoredAttachment {
  readonly sha256: string
  readonly mime: string
  readonly bytes: number
}

export interface AttachmentStore {
  /** Store bytes; returns the content address + metadata. Idempotent. */
  readonly put: (bytes: Uint8Array, mime: string) => Promise<StoredAttachment>
  /** Fetch stored bytes by content address; null when absent. */
  readonly get: (sha256: string) => Promise<{ mime: string; bytes: Uint8Array } | null>
  readonly root: string
}

const SAFE_SHA = /^[a-f0-9]{64}$/

export function createAttachmentStore(rootDir: string): AttachmentStore {
  return {
    root: rootDir,
    async put(bytes, mime) {
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const target = join(rootDir, sha256.slice(0, 2), sha256)
      try {
        const s = await stat(target)
        if (s.size === bytes.length) return { sha256, mime, bytes: bytes.length }
      } catch {
        // not stored yet — fall through to the write below
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      return { sha256, mime, bytes: bytes.length }
    },
    async get(sha256) {
      if (!SAFE_SHA.test(sha256)) return null
      try {
        // mime is not persisted per object: callers carry it in the reference
        // (the log row is the metadata source of truth, not the blob store).
        const bytes = new Uint8Array(await readFile(join(rootDir, sha256.slice(0, 2), sha256)))
        return { mime: "application/octet-stream", bytes }
      } catch {
        return null
      }
    },
  }
}

/** Decode raw base64 (no data: prefix) into bytes; null when malformed. */
export function base64ToBytes(data: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return null
  return new Uint8Array(Buffer.from(data, "base64"))
}

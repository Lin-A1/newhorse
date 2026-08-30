import type { Database } from "bun:sqlite"

/**
 * VectorIndex seam — nearest-neighbor search over fixed-dimension vectors for
 * semantic memory. Two shipping implementations:
 *
 *  - `brute`      : in-memory Float32Array map with a linear scan. Always
 *                   available; because the vectors stay resident, a search no
 *                   longer re-reads and re-deserializes every BLOB from SQLite
 *                   (the cost the pre-index scan paid on every query).
 *  - `sqlite-vec` : the vec0 extension (asg017/sqlite-vec) for indexed KNN at
 *                   scale. Loaded best-effort per connection; when the
 *                   extension (or its platform binary) is absent the store
 *                   falls back to `brute`, and a host can inject its own index
 *                   (hnsw, an external vector DB, …) through the same seam.
 *
 * `scope` is an isolation partition (the memory's session id): a scoped search
 * only ranks vectors written under the SAME scope, so one busy session's
 * memories cannot crowd another session out of its top-k. Unscoped searches
 * rank the whole index.
 *
 * Contract: every method fails soft — `upsert` returns false, `search`
 * returns [] — mirroring the EmbeddingProvider rule that the vector path must
 * never fail a write or a search. `search` returns the k nearest by cosine,
 * best first, score = cosine SIMILARITY (higher = closer).
 */
export interface VectorIndex {
  readonly mode: "brute" | "sqlite-vec"
  readonly upsert: (id: string, vec: Float32Array, scope?: string) => boolean
  readonly remove: (id: string) => void
  readonly search: (query: Float32Array, k: number, scope?: string) => ReadonlyArray<{ id: string; score: number }>
  readonly size: () => number
}

/** Exact search over resident Float32Array rows (norms precomputed at upsert). */
export function createBruteForceIndex(): VectorIndex {
  const rows = new Map<string, { vec: Float32Array; norm: number; scope?: string }>()
  return {
    mode: "brute",
    upsert(id, vec, scope) {
      let norm = 0
      for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!
      norm = Math.sqrt(norm)
      if (norm === 0) return false
      rows.set(id, { vec, norm, scope })
      return true
    },
    remove(id) {
      rows.delete(id)
    },
    search(q, k, scope) {
      let qn = 0
      for (let i = 0; i < q.length; i++) qn += q[i]! * q[i]!
      qn = Math.sqrt(qn)
      if (qn === 0 || k <= 0) return []
      const scored: { id: string; score: number }[] = []
      for (const [id, r] of rows) {
        if (scope !== undefined && r.scope !== scope) continue
        if (r.vec.length !== q.length) continue
        let dot = 0
        for (let i = 0; i < q.length; i++) dot += q[i]! * r.vec[i]!
        scored.push({ id, score: dot / (qn * r.norm) })
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, k)
    },
    size: () => rows.size,
  }
}

/**
 * vec0-backed index persisted in the SAME SQLite file as the memories (the
 * vec0 table is a DERIVED index — the `memory.embedding` BLOB stays canonical,
 * and the store rebuilds this table from BLOBs at attach time). Uses a TEXT
 * primary key so memory ids map 1:1, and a partition key so scoped (per
 * session) KNN stays exact within the scope. Returns undefined when the
 * extension is not loaded on this connection or the table cannot serve the
 * requested dimensions (a stale table with different dims is replaced).
 */
export function createSqliteVecIndex(db: Database, dims: number, table = "memory_vec"): VectorIndex | undefined {
  const blob = (vec: Float32Array): Buffer => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
  const ensureTable = (): boolean => {
    try {
      db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(id text primary key, scope text partition key, embedding float32[${dims}] distance_metric=cosine)`)
      // The canary proves the table actually serves this dimensionality AND
      // the cosine metric: an orthogonal query reports distance 1 under
      // cosine but sqrt(2) under an L2 table left by an older build — both
      // would otherwise fail every upsert/search silently (fail-soft), so a
      // stale table is replaced instead.
      const probe = new Float32Array(dims)
      probe[0] = 1
      const ortho = new Float32Array(dims)
      if (dims >= 2) ortho[1] = 1
      db.query(`INSERT INTO ${table}(id, scope, embedding) VALUES (?, ?, ?)`).run("__newhorse_canary__", "__newhorse_canary__", blob(probe))
      let metricOk = true
      if (dims >= 2) {
        const rows = db.query(`SELECT distance FROM ${table} WHERE scope = ? AND embedding MATCH ? AND k = ?`).all("__newhorse_canary__", blob(ortho), 1) as { distance: number }[]
        metricOk = rows.length === 1 && Math.abs(Number(rows[0]!.distance) - 1) < 0.01
      }
      db.query(`DELETE FROM ${table} WHERE id = ?`).run("__newhorse_canary__")
      return metricOk
    } catch {
      return false
    }
  }
  if (!ensureTable()) {
    try {
      db.run(`DROP TABLE IF EXISTS ${table}`)
    } catch {
      return undefined
    }
    if (!ensureTable()) return undefined
  }
  return {
    mode: "sqlite-vec",
    upsert(id, vec, scope) {
      try {
        // vec0 has no ON CONFLICT upsert for the PK — replace = delete+insert.
        db.query(`DELETE FROM ${table} WHERE id = ?`).run(id)
        db.query(`INSERT INTO ${table}(id, scope, embedding) VALUES (?, ?, ?)`).run(id, scope ?? null, blob(vec))
        return true
      } catch {
        return false
      }
    },
    remove(id) {
      db.query(`DELETE FROM ${table} WHERE id = ?`).run(id)
    },
    search(q, k, scope) {
      try {
        // Bound params must go through .run/.all — Bun does not bind params
        // passed as the second argument of db.query() into a vec0 MATCH.
        const rows = (scope !== undefined
          ? db.query(`SELECT id, distance FROM ${table} WHERE scope = ? AND embedding MATCH ? AND k = ?`).all(scope, blob(q), k)
          : db.query(`SELECT id, distance FROM ${table} WHERE embedding MATCH ? AND k = ?`).all(blob(q), k)) as { id: string; distance: number }[]
        // Cosine distance -> similarity; defensive sort (vec0 KNN is ordered,
        // but the seam contract must not depend on it).
        return rows.map((r) => ({ id: String(r.id), score: 1 - Number(r.distance) })).sort((a, b) => b.score - a.score)
      } catch {
        return []
      }
    },
    size: () => {
      try {
        return (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
      } catch {
        return 0
      }
    },
  }
}

/**
 * Load the vec0 extension into THIS connection (best-effort). Returns false
 * when the sqlite-vec package or its platform binary is absent — the caller
 * then falls back to the brute index or a host-injected one.
 */
export async function loadSqliteVec(db: Database): Promise<boolean> {
  try {
    const mod = (await import("sqlite-vec")) as { getLoadablePath?: () => string } & { default?: { getLoadablePath?: () => string } }
    const getPath = mod.getLoadablePath ?? mod.default?.getLoadablePath
    if (!getPath) return false
    db.loadExtension(getPath())
    return true
  } catch {
    return false
  }
}

/** Serialize a vector as a little-endian Float32 BLOB (compact storage). */
export function float32Blob(vec: readonly number[] | Float32Array): Buffer {
  const f = vec instanceof Float32Array ? vec : new Float32Array(vec)
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

/** Deserialize a stored BLOB back into a Float32Array (no copy of the bytes). */
export function blobToFloat32(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4))
}

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Identifier } from "../../id/id"
import { extractEntities } from "../../memory/entity"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812160231_add_memory_fts_entity_history",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_entity\` (
          \`id\` text PRIMARY KEY,
          \`memory_id\` text NOT NULL,
          \`entity_text\` text NOT NULL,
          \`entity_type\` text NOT NULL,
          \`normalized_text\` text NOT NULL,
          CONSTRAINT \`fk_memory_entity_memory_id_memory_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_history\` (
          \`id\` text PRIMARY KEY,
          \`memory_id\` text,
          \`old_content\` text,
          \`new_content\` text,
          \`event\` text NOT NULL,
          \`actor_id\` text,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_entity_memory_idx\` ON \`memory_entity\` (\`memory_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_entity_normalized_idx\` ON \`memory_entity\` (\`normalized_text\`,\`memory_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_history_memory_idx\` ON \`memory_history\` (\`memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_history_created_at_idx\` ON \`memory_history\` (\`created_at\`);`)

      // FTS5 full-text index (external content: token postings live in the
      // virtual table, the text itself stays in memory). Trigger-free: the
      // memory service maintains memory_fts from its write paths so the index
      // survives migrations that skip running (fresh installs run schema.up and
      // mark migrations complete; the service lazily creates memory_fts there).
      // tokenize='trigram': unicode61 does not segment CJK, and relationship /
      // recall queries are natural language (often Chinese); trigram indexes
      // every 3-character sequence and handles both Latin and CJK.
      yield* tx.run(`
        CREATE VIRTUAL TABLE \`memory_fts\` USING fts5(
          content,
          content='memory',
          tokenize='trigram'
        );
      `)
      yield* tx.run(`
        INSERT INTO \`memory_fts\` (rowid, content)
        SELECT \`rowid\`, \`content\` FROM \`memory\`;
      `)

      // Backfill the entity graph for pre-existing memories so the search boost
      // applies to them too (new saves extract entities at write time).
      const rows = yield* tx.all<{ id: string; content: string }>(
        sql`SELECT id, content FROM memory`,
      )
      for (const row of rows) {
        for (const entity of extractEntities(row.content)) {
          yield* tx.run(
            sql`INSERT INTO \`memory_entity\` (id, memory_id, entity_text, entity_type, normalized_text) VALUES (${Identifier.ascending("memoryEntity")}, ${row.id}, ${entity.text}, ${entity.type}, ${entity.normalized})`,
          )
        }
      }
    })
  },
} satisfies DatabaseMigration.Migration

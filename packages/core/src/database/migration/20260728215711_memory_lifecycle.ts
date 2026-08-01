import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260728215711_memory_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory\` ADD \`directory\` text;`)
      yield* tx.run(`
        UPDATE \`memory\`
        SET \`directory\` = (
          SELECT \`session\`.\`directory\`
          FROM \`session\`
          WHERE \`session\`.\`id\` = \`memory\`.\`source_session_id\`
        )
        WHERE \`scope\` = 'workspace'
          AND \`workspace_id\` IS NULL
          AND \`source_session_id\` IS NOT NULL;
      `)
      yield* tx.run(`
        DELETE FROM \`memory\`
        WHERE \`scope\` = 'workspace'
          AND \`workspace_id\` IS NULL
          AND \`directory\` IS NULL;
      `)
      yield* tx.run(`CREATE INDEX \`memory_directory_idx\` ON \`memory\` (\`directory\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_scope_owner_profile_status_time_idx\` ON \`memory\` (\`scope\`,\`workspace_id\`,\`directory\`,\`profile_id\`,\`status\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`memory_relationship_profile_status_idx\` ON \`memory\` (\`kind\`,\`profile_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

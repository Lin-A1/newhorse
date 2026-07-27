import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726030626_add_session_profile_id",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`profile_id\` text;`)
      yield* tx.run(`CREATE INDEX \`session_profile_idx\` ON \`session\` (\`profile_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration

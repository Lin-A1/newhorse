import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801110000_scheduler_directory_scope",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX \`scheduled_event_idempotency_idx\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_event_idempotency_idx\` ON \`scheduled_event\` (\`idempotency_key\`,\`profile_id\`,coalesce(\`workspace_id\`, \`directory\`));`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801111000_scheduler_eligible_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX \`scheduled_event_due_idx\`;`)
      yield* tx.run(
        `CREATE INDEX \`scheduled_event_due_idx\` ON \`scheduled_event\` (\`status\`,\`eligible_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

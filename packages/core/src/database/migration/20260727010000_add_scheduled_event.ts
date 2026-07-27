import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727010000_add_scheduled_event",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`scheduled_event\` (
          \`id\` text PRIMARY KEY,
          \`idempotency_key\` text NOT NULL,
          \`workspace_id\` text,
          \`directory\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`session_id\` text,
          \`type\` text NOT NULL,
          \`title\` text NOT NULL,
          \`body\` text NOT NULL,
          \`schedule_at\` integer NOT NULL,
          \`timezone\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`lease_owner\` text,
          \`lease_expires_at\` integer,
          \`attempt_count\` integer DEFAULT 0 NOT NULL,
          \`last_error\` text,
          \`last_fired_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`scheduled_event_due_idx\` ON \`scheduled_event\` (\`status\`, \`schedule_at\`);`)
      yield* tx.run(`CREATE INDEX \`scheduled_event_lease_idx\` ON \`scheduled_event\` (\`lease_expires_at\`);`)
      yield* tx.run(`CREATE INDEX \`scheduled_event_workspace_idx\` ON \`scheduled_event\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`scheduled_event_profile_idx\` ON \`scheduled_event\` (\`profile_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_event_idempotency_idx\` ON \`scheduled_event\` (\`idempotency_key\`, \`profile_id\`, coalesce(\`workspace_id\`, ''));`,
      )
      yield* tx.run(`
        CREATE TABLE \`scheduled_event_audit\` (
          \`id\` text PRIMARY KEY,
          \`event_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`scheduled_event_audit_event_id_fk\` FOREIGN KEY (\`event_id\`) REFERENCES \`scheduled_event\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`scheduled_event_audit_event_idx\` ON \`scheduled_event_audit\` (\`event_id\`, \`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

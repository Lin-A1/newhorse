import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260730133911_add_continuity_grant",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`continuity_grant_audit\` (
          \`id\` text PRIMARY KEY,
          \`grant_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`reason\` text,
          \`destination_session_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_continuity_grant_audit_grant_id_continuity_grant_id_fk\` FOREIGN KEY (\`grant_id\`) REFERENCES \`continuity_grant\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`continuity_grant\` (
          \`id\` text PRIMARY KEY,
          \`source_workspace_id\` text,
          \`source_directory\` text NOT NULL,
          \`source_profile_id\` text NOT NULL,
          \`source_session_id\` text NOT NULL,
          \`destination_workspace_id\` text NOT NULL,
          \`destination_directory\` text NOT NULL,
          \`destination_profile_id\` text NOT NULL,
          \`destination_session_id\` text NOT NULL,
          \`purpose\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`relationship_persistence\` integer DEFAULT false NOT NULL,
          \`time_expires\` integer NOT NULL,
          \`status\` text DEFAULT 'proposed' NOT NULL,
          \`time_approved\` integer,
          \`time_revoked\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`continuity_grant_audit_idx\` ON \`continuity_grant_audit\` (\`grant_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`continuity_grant_source_idx\` ON \`continuity_grant\` (\`source_session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`continuity_grant_destination_idx\` ON \`continuity_grant\` (\`destination_session_id\`,\`destination_workspace_id\`,\`destination_profile_id\`,\`status\`,\`time_expires\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const PresenceSegmentTable = sqliteTable("presence_segment", {
  /** Local date key YYYY-MM-DD. */
  day: text().notNull(),
  app: text().notNull(),
  start: integer().notNull(),
  /** null = segment still open. */
  end: integer(),
})

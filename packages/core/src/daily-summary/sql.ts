import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export const DailySummaryTable = sqliteTable("daily_summary", {
  /** Local date key YYYY-MM-DD — one summary per day. */
  date: text().primaryKey(),
  content: text().notNull(),
  ...Timestamps,
})

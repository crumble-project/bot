import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { relayEvents } from "../event-sources/schema";
import { schedules } from "../bot-store/schema.schedules";

export type EventRunStatus = "pending" | "dispatched" | "failed";

export const eventRuns = sqliteTable(
  "event_runs",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => relayEvents.id, { onDelete: "cascade" }),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    status: text("status").$type<EventRunStatus>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("event_runs_once").on(table.eventId, table.scheduleId),
    index("event_runs_by_schedule").on(
      table.scheduleId,
      table.status,
      table.eventId,
    ),
  ],
);

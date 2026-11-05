import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { relayEvents } from "../event-sources/schema";
import { schedules } from "./schema";

export type EventRunStatus = "pending" | "dispatched" | "failed";

/** One automation's run for one event; runs of an automation go out oldest event first. */
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

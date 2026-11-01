import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { schedules } from "../schedules/schema";

export const eventSources = sqliteTable("event_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const relayEvents = sqliteTable(
  "relay_events",
  {
    id: text("id").primaryKey(),
    // No foreign key: a deleted source's events still deduplicate redeliveries.
    sourceId: text("source_id").notNull(),
    receivedAt: text("received_at").notNull(),
    method: text("method").notNull(),
    query: text("query").notNull(),
    headers: text("headers", { mode: "json" })
      .$type<[string, string][]>()
      .notNull(),
    body: text("body").notNull(),
    storedAt: text("stored_at").notNull(),
  },
  (table) => [index("relay_events_by_stored_at").on(table.storedAt)],
);

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

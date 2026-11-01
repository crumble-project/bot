import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

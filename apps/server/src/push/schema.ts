import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const pushSettings = sqliteTable("push_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const pushDevices = sqliteTable("push_devices", {
  installationId: text("installation_id").primaryKey(),
  platform: text("platform").notNull(),
  transport: text("transport").notNull(),
  token: text("token").notNull(),
  environment: text("environment").notNull(),
  bundleId: text("bundle_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const pushPresence = sqliteTable("push_presence", {
  installationId: text("installation_id")
    .primaryKey()
    .references(() => pushDevices.installationId, { onDelete: "cascade" }),
  active: integer("active", { mode: "boolean" }).notNull(),
  agentId: text("agent_id"),
  refreshedAt: integer("refreshed_at").notNull(),
});

export const pushOutbox = sqliteTable("push_outbox", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  eventJson: text("event_json").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const pushDelivery = sqliteTable(
  "push_delivery",
  {
    outboxId: text("outbox_id")
      .notNull()
      .references(() => pushOutbox.id, { onDelete: "cascade" }),
    installationId: text("installation_id")
      .notNull()
      .references(() => pushDevices.installationId, { onDelete: "cascade" }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    delivered: integer("delivered", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [primaryKey({ columns: [table.outboxId, table.installationId] })],
);

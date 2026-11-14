import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import {
  PUSH_ENVIRONMENTS,
  PUSH_PLATFORMS,
  PUSH_TRANSPORTS,
} from "../shared/push-devices";

export const pushSettings = sqliteTable("push_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const pushDevices = sqliteTable("push_devices", {
  installationId: text("installation_id").primaryKey(),
  platform: text("platform", { enum: PUSH_PLATFORMS }).notNull(),
  transport: text("transport", { enum: PUSH_TRANSPORTS }).notNull(),
  token: text("token").notNull(),
  environment: text("environment", { enum: PUSH_ENVIRONMENTS }).notNull(),
  bundleId: text("bundle_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const chatViews = sqliteTable("chat_views", {
  viewId: text("view_id").primaryKey(),
  chatKind: text("chat_kind", { enum: ["bot", "group"] }).notNull(),
  chatId: text("chat_id").notNull(),
  refreshedAt: integer("refreshed_at").notNull(),
});

export const replyAssociations = sqliteTable("reply_associations", {
  eventId: text("event_id").primaryKey(),
  chatKind: text("chat_kind", { enum: ["bot", "group"] }).notNull(),
  chatId: text("chat_id").notNull(),
  messageId: text("message_id").notNull(),
  entryId: text("entry_id").notNull(),
  surfaceJson: text("surface_json").notNull(),
  seen: integer("seen", { mode: "boolean" }).notNull().default(false),
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

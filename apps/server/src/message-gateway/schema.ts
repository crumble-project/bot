import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  foreignKey,
  index,
} from "drizzle-orm/sqlite-core";

export const gatewayReceipts = sqliteTable(
  "gateway_receipts",
  {
    adapterId: text("adapter_id").notNull(),
    messageId: text("message_id").notNull(),
    channelId: text("channel_id").notNull(),
    senderId: text("sender_id").notNull(),
    isDirectMessage: integer("is_direct_message", {
      mode: "boolean",
    }).notNull(),
    botId: text("bot_id"),
    requestId: text("request_id").notNull(),
    text: text("text").notNull(),
    executionId: text("execution_id"),
    chunks: text("chunks", { mode: "json" }).$type<string[] | null>(),
    sent: text("sent", { mode: "json" }).$type<string[]>().notNull(),
    state: text("state", { enum: ["pending", "done", "failed"] }).notNull(),
    createdAt: integer("created_at").notNull().default(0),
    expiresAt: integer("expires_at").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    failedAt: integer("failed_at"),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    primaryKey({ columns: [table.adapterId, table.messageId] }),
    index("gateway_receipts_pending").on(table.state, table.nextAttemptAt),
    index("gateway_receipts_retention").on(table.finishedAt),
  ],
);

export const gatewaySentMessages = sqliteTable(
  "gateway_sent_messages",
  {
    adapterId: text("adapter_id").notNull(),
    channelId: text("channel_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    receiptMessageId: text("receipt_message_id").notNull(),
    botId: text("bot_id").notNull(),
    expiresAt: integer("expires_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.adapterId, table.channelId, table.externalMessageId],
    }),
    index("gateway_sent_messages_receipt").on(
      table.adapterId,
      table.receiptMessageId,
    ),
    foreignKey({
      columns: [table.adapterId, table.receiptMessageId],
      foreignColumns: [gatewayReceipts.adapterId, gatewayReceipts.messageId],
    }).onDelete("cascade"),
  ],
);

export const gatewayCooldowns = sqliteTable(
  "gateway_cooldowns",
  {
    adapterId: text("adapter_id").notNull(),
    scope: text("scope", { enum: ["adapter", "channel"] }).notNull(),
    channelId: text("channel_id").notNull(),
    until: integer("until").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.adapterId, table.scope, table.channelId] }),
    index("gateway_cooldowns_expiry").on(table.until),
  ],
);

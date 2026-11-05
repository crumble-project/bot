import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";

export const BOT_REQUEST_STATUSES = [
  "pending",
  "approved",
  "declined",
] as const;

export const botRequests = sqliteTable(
  "bot_requests",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    proposal: text("proposal").notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: BOT_REQUEST_STATUSES }).notNull(),
    createdAgentId: text("created_agent_id"),
    requestedAt: text("requested_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (table) => [index("bot_requests_by_agent").on(table.agentId)],
);

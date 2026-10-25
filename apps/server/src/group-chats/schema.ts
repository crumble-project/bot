import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { agents, executions } from "../bots/schema";

export const groupChats = sqliteTable("group_chats", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  botTurns: integer("bot_turns").notNull().default(0),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  awaitingAnswers: text("awaiting_answers").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groupChats.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    joinedAt: text("joined_at").notNull(),
    conversationId: text("conversation_id"),
    cursor: integer("cursor").notNull().default(0),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),
    pendingBotStarted: integer("pending_bot_started", { mode: "boolean" })
      .notNull()
      .default(false),
    summary: text("summary"),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.agentId] })],
);

export const groupTurns = sqliteTable("group_turns", {
  executionId: text("execution_id")
    .primaryKey()
    .references(() => executions.id, { onDelete: "cascade" }),
  groupId: text("group_id")
    .notNull()
    .references(() => groupChats.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  through: integer("through").notNull(),
  botStarted: integer("bot_started", { mode: "boolean" }).notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

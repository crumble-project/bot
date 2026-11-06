import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bot-store/schema";

export const reviewCounters = sqliteTable("review_counters", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  skillRounds: integer("skill_rounds").notNull().default(0),
  memoryRounds: integer("memory_rounds").notNull().default(0),
});

export const pendingReviews = sqliteTable("pending_reviews", {
  executionId: text("execution_id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull(),
  createdAt: text("created_at").notNull(),
});

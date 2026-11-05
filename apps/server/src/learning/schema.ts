import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";
import {
  CHANGE_ACTIONS,
  CHANGE_ACTORS,
  CHANGE_TARGETS,
} from "../shared/domain";

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

export const reviewResults = sqliteTable("review_results", {
  executionId: text("execution_id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  changeIds: text("change_ids").notNull(),
  createdAt: text("created_at").notNull(),
});

// Changes outlive their targets and bots, so they carry the bot ID without a foreign key.
export const learnedChanges = sqliteTable(
  "learned_changes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id"),
    actor: text("actor", { enum: CHANGE_ACTORS }).notNull(),
    target: text("target", { enum: CHANGE_TARGETS }).notNull(),
    targetId: text("target_id").notNull(),
    action: text("action", { enum: CHANGE_ACTIONS }).notNull(),
    beforeState: text("before_state"),
    afterState: text("after_state"),
    source: text("source"),
    revertsId: text("reverts_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("learned_changes_agent").on(table.agentId, table.createdAt),
  ],
);

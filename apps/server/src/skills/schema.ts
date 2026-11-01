import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";
import { changeActions, changeActors } from "../shared/domain";

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  instructions: text("instructions").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  agentId: text("agent_id").references(() => agents.id, {
    onDelete: "cascade",
  }),
  description: text("description").notNull().default(""),
  createdBy: text("created_by").notNull().default("owner"),
  sourceExecutionId: text("source_execution_id"),
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: text("last_used_at"),
  state: text("state").notNull().default("active"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  // JSON SkillOrigin; set for skills installed from GitHub.
  origin: text("origin"),
});

/** The latest upstream state of an installed skill; `digest` is null when its folder is gone. */
export const skillUpdates = sqliteTable("skill_updates", {
  skillId: text("skill_id")
    .primaryKey()
    .references(() => skills.id, { onDelete: "cascade" }),
  commit: text("commit").notNull(),
  digest: text("digest"),
  checkedAt: text("checked_at").notNull(),
});

export const skillDocuments = sqliteTable(
  "skill_documents",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
  },
  (table) => [primaryKey({ columns: [table.skillId, table.path] })],
);

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
    actor: text("actor", { enum: changeActors }).notNull(),
    target: text("target", { enum: ["skill", "memory"] }).notNull(),
    targetId: text("target_id").notNull(),
    action: text("action", { enum: changeActions }).notNull(),
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

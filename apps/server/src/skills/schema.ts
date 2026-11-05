import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { agents } from "../bot-store/schema";

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
  // Deliberately not a foreign key: deleting a source must not unlink or delete copies.
  copiedFromSkillId: text("copied_from_skill_id"),
  // JSON SkillOrigin; set for skills installed from GitHub.
  origin: text("origin"),
});

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

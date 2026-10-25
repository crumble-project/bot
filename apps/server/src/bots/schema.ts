import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  avatar: text("avatar").notNull(),
  description: text("description").notNull(),
  instructions: text("instructions").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  tools: text("tools").notNull(),
  // Inline skills moved to the skill library; the column stays `[]` for databases that predate it.
  skills: text("skills").notNull(),
  mcpServers: text("mcp_servers").notNull(),
  delegates: text("delegates").notNull().default("[]"),
  inference: text("inference").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  sharedSkills: text("shared_skills").notNull().default("[]"),
  desktopModel: text("desktop_model"),
  reviewModel: text("review_model"),
  review: text("review"),
  sharedMemory: integer("shared_memory", { mode: "boolean" })
    .notNull()
    .default(false),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { WEB_SEARCH_PROVIDER_IDS } from "../shared/vendors";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  avatar: text("avatar").notNull(),
  description: text("description").notNull(),
  instructions: text("instructions").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  webSearchProvider: text("web_search_provider", {
    enum: WEB_SEARCH_PROVIDER_IDS,
  }),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  tools: text("tools").notNull(),
  mcpServers: text("mcp_servers").notNull(),
  inference: text("inference").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  sharedSkills: text("shared_skills").notNull().default("[]"),
  desktopModel: text("desktop_model"),
  reviewModel: text("review_model"),
  review: text("review"),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  /** The bot's one continuous chat, as opposed to its working conversations. */
  chat: integer("chat", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

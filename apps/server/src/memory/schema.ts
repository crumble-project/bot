import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id, {
    onDelete: "cascade",
  }),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  source: text("source"),
});

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  cron: text("cron"),
  timezone: text("timezone").notNull(),
  runAt: text("run_at"),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  nextRunAt: text("next_run_at"),
  createdAt: text("created_at").notNull(),
  createdByAgentId: text("created_by_agent_id"),
});

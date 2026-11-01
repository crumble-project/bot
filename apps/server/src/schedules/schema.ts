import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";
import type { ScheduleKind } from "../shared/domain";

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").$type<ScheduleKind>().notNull().default("prompt"),
  prompt: text("prompt").notNull(),
  command: text("command"),
  timeoutSeconds: integer("timeout_seconds").notNull().default(600),
  notify: integer("notify", { mode: "boolean" }).notNull().default(true),
  cron: text("cron"),
  timezone: text("timezone").notNull(),
  runAt: text("run_at"),
  eventSourceId: text("event_source_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  nextRunAt: text("next_run_at"),
  createdAt: text("created_at").notNull(),
  createdByAgentId: text("created_by_agent_id"),
});

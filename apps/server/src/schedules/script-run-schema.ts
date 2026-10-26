import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ScriptRunStatus } from "../shared/domain";
import { schedules } from "./schema";

export const scriptRuns = sqliteTable(
  "script_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    command: text("command").notNull(),
    status: text("status").$type<ScriptRunStatus>().notNull(),
    exitCode: integer("exit_code"),
    output: text("output").notNull().default(""),
    droppedBytes: integer("dropped_bytes").notNull().default(0),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("script_runs_by_schedule").on(table.scheduleId, table.startedAt),
    index("script_runs_by_time").on(table.startedAt),
  ],
);

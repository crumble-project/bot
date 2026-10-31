import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { schedules } from "../schedules/schema";
import { agents, conversations } from "./schema";

export const executions = sqliteTable(
  "executions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    scheduleId: text("schedule_id").references(() => schedules.id, {
      onDelete: "set null",
    }),
    submissionId: text("submission_id"),
    requestId: text("request_id").notNull(),
    prompt: text("prompt"),
    replyTo: text("reply_to"),
    status: text("status", {
      enum: ["pending", "running", "done", "failed", "cancelled"],
    }).notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    attachments: text("attachments"),
    attachmentsDigest: text("attachments_digest"),
  },
  (table) => [
    uniqueIndex("executions_conversation_request").on(
      table.conversationId,
      table.requestId,
    ),
  ],
);

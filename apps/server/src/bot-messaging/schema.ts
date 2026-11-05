import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bot-store/schema";
import { executions } from "../bot-store/schema.executions";

/** A sent bot message's destination, reserved before admission so a replay cannot reach a second bot. */
export const botMessageRequests = sqliteTable("bot_message_requests", {
  requestId: text("request_id").primaryKey(),
  sourceAgentId: text("source_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  targetAgentId: text("target_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  recipient: text("recipient").notNull(),
  message: text("message").notNull(),
});

/** Who sent the bot message an execution answers. */
export const delegationReceipts = sqliteTable("delegation_receipts", {
  executionId: text("execution_id")
    .primaryKey()
    .references(() => executions.id, { onDelete: "cascade" }),
  sourceAgentId: text("source_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  targetAgentId: text("target_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
});

/** A job question relayed to the bot that delegated the job's task. */
export const relayedJobQuestions = sqliteTable("relayed_job_questions", {
  questionId: text("question_id").primaryKey(),
  reporterAgentId: text("reporter_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  assigneeAgentId: text("assignee_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  job: text("job").notNull(),
});

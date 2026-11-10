import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bot-store/schema";
import {
  CALL_REQUEST_OUTCOMES,
  CALL_REQUEST_STATUSES,
} from "../contract/voice-gateway";

export const callRequests = sqliteTable(
  "call_requests",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    callee: text("callee").notNull(),
    goal: text("goal").notNull(),
    opening: text("opening").notNull(),
    status: text("status", { enum: CALL_REQUEST_STATUSES }).notNull(),
    callId: text("call_id"),
    conversationId: text("conversation_id"),
    outcome: text("outcome", { enum: CALL_REQUEST_OUTCOMES }),
    error: text("error"),
    requestedAt: text("requested_at").notNull(),
    decidedAt: text("decided_at"),
    endedAt: text("ended_at"),
  },
  (table) => [
    index("call_requests_by_agent").on(table.agentId),
    index("call_requests_by_call").on(table.callId),
  ],
);

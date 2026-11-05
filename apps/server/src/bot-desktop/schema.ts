import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bot-store/schema";

export const desktopControl = sqliteTable("desktop_control", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  holder: text("holder").notNull(),
  changes: integer("changes").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const desktopFills = sqliteTable(
  "desktop_fills",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    label: text("label").notNull(),
    browser: text("browser").notNull(),
    filledAt: text("filled_at").notNull(),
  },
  (table) => [index("desktop_fills_agent").on(table.agentId)],
);

export const heldActions = sqliteTable(
  "held_actions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    job: text("job").notNull(),
    action: text("action").notNull(),
    page: text("page"),
    ownerMessages: text("owner_messages").notNull(),
    reason: text("reason").notNull(),
    /** pending, approved, declined, or expired: a restart ends every wait. */
    status: text("status").notNull(),
    declineReason: text("decline_reason"),
    heldAt: text("held_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (table) => [index("held_actions_agent").on(table.agentId)],
);

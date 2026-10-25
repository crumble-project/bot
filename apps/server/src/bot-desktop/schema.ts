import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";

export const desktopControl = sqliteTable("desktop_control", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  holder: text("holder").notNull(),
  changes: integer("changes").notNull(),
  updatedAt: text("updated_at").notNull(),
});

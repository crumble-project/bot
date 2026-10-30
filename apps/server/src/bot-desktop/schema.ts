import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";

export const desktopControl = sqliteTable("desktop_control", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  holder: text("holder").notNull(),
  changes: integer("changes").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Every password typed on a bot's desktop, encrypted with the account's key, and the Chromium instance it went into.
 * Results stay scrubbed of these for the desktop's life, whatever happens to the login.
 */
export const desktopFills = sqliteTable(
  "desktop_fills",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    label: text("label").notNull(),
    /** Chromium's pid and start time: screenshots stay off while that Chromium runs. */
    browser: text("browser").notNull(),
    filledAt: text("filled_at").notNull(),
  },
  (table) => [index("desktop_fills_agent").on(table.agentId)],
);

import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { hostBoundRequest, hostBoundSecret } from "../credentials/schema";
import type { LoginField } from "../shared/domain";

export const logins = sqliteTable("logins", hostBoundSecret(), (table) => [
  primaryKey({ columns: [table.agentId, table.name] }),
]);

export const loginUses = sqliteTable(
  "login_uses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    at: text("at").notNull(),
    host: text("host").notNull(),
    field: text("field").$type<LoginField>().notNull(),
    /** Why the value couldn't be read from its password manager; nothing was typed. */
    error: text("error"),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId, table.name],
      foreignColumns: [logins.agentId, logins.name],
    }).onDelete("cascade"),
    index("login_uses_by_login").on(table.agentId, table.name, table.id),
    index("login_uses_by_time").on(table.at),
  ],
);

/** A bot's request for a login it has no login for, waiting for the owner; one per bot and name. */
export const loginRequests = sqliteTable(
  "login_requests",
  {
    ...hostBoundRequest(),
    oneTimeCode: integer("one_time_code", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.name] })],
);

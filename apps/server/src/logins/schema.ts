import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";
import { hostBoundSecret } from "../credentials/schema";
import { oneSecretSource, secretSource } from "../password-managers/schema";
import type { LoginField } from "../shared/domain";

export const logins = sqliteTable("logins", hostBoundSecret(), (table) => [
  primaryKey({ columns: [table.agentId, table.name] }),
]);

/** One row per field a login has; a login always has a username and a password. */
export const loginFields = sqliteTable(
  "login_fields",
  {
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    field: text("field").$type<LoginField>().notNull(),
    value: secretSource.value(),
    passwordManager: secretSource.passwordManager(),
    reference: secretSource.reference(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.name, table.field] }),
    foreignKey({
      columns: [table.agentId, table.name],
      foreignColumns: [logins.agentId, logins.name],
    }).onDelete("cascade"),
    check(
      "login_fields_field",
      sql`${table.field} IN ('username', 'password', 'one_time_code')`,
    ),
    oneSecretSource("login_fields_source", table),
  ],
);

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
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hosts: text("hosts").notNull(),
    reason: text("reason").notNull(),
    oneTimeCode: integer("one_time_code", { mode: "boolean" }).notNull(),
    requestedAt: text("requested_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.name] })],
);

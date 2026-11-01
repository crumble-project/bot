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
import { sql } from "drizzle-orm";
import { passwordManagers } from "../password-managers/schema";
import type { PasswordManagerId } from "../shared/domain";

/**
 * Values by key, such as every secret the owner enters (see `Secrets`): stored encrypted in `value`, or read from a
 * password manager by `reference`. Exactly one of the two is set; a password manager in use can't be removed.
 */
export const secrets = sqliteTable(
  "credentials",
  {
    key: text("key").primaryKey(),
    value: text("value"),
    passwordManager: text("password_manager")
      .$type<PasswordManagerId>()
      .references(() => passwordManagers.id, { onDelete: "restrict" }),
    reference: text("reference"),
  },
  (table) => [
    check(
      "credentials_source",
      sql`(${table.value} IS NOT NULL AND ${table.passwordManager} IS NULL AND ${table.reference} IS NULL) OR (${table.value} IS NULL AND ${table.passwordManager} IS NOT NULL AND ${table.reference} IS NOT NULL)`,
    ),
  ],
);

/** A bot's name for something that only goes to `hosts`, a JSON list. */
const hostBound = () => ({
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hosts: text("hosts").notNull(),
});

/** The columns of an agent's named secret that only goes to `hosts`: a credential, or a login. */
export const hostBoundSecret = () => ({
  ...hostBound(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

export const agentCredentials = sqliteTable(
  "agent_credentials",
  {
    ...hostBoundSecret(),
    placeholder: text("placeholder").notNull().unique(),
    /** The value is a token from the bot's GitHub App; otherwise it is a secret under `credentialSecretKey`. */
    github: integer("github", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.name] })],
);

export const credentialAuthorities = sqliteTable("credential_authorities", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  certificate: text("certificate").notNull(),
  key: text("key").notNull(),
});

/** The columns of a bot's request for a host-bound secret, waiting for the owner. */
export const hostBoundRequest = () => ({
  ...hostBound(),
  reason: text("reason").notNull(),
  requestedAt: text("requested_at").notNull(),
});

export const credentialRequests = sqliteTable(
  "credential_requests",
  hostBoundRequest(),
  (table) => [primaryKey({ columns: [table.agentId, table.name] })],
);

export const credentialUses = sqliteTable(
  "credential_uses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    at: text("at").notNull(),
    method: text("method").notNull(),
    host: text("host").notNull(),
    path: text("path").notNull(),
    status: integer("status"),
    /** Why the value couldn't be read from its password manager; the request was never sent. */
    error: text("error"),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId, table.name],
      foreignColumns: [agentCredentials.agentId, agentCredentials.name],
    }).onDelete("cascade"),
    index("credential_uses_by_credential").on(
      table.agentId,
      table.name,
      table.id,
    ),
    index("credential_uses_by_time").on(table.at),
  ],
);

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
import {
  hasOneSecretSource,
  oneSecretSource,
  secretSource,
} from "../password-managers/schema";

/** Encrypted secrets by key, such as an MCP server's token. */
export const secrets = sqliteTable(
  "credentials",
  {
    key: text("key").primaryKey(),
    value: secretSource.value(),
    passwordManager: secretSource.passwordManager(),
    reference: secretSource.reference(),
  },
  (table) => [oneSecretSource("credentials_source", table)],
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
    value: secretSource.value(),
    passwordManager: secretSource.passwordManager(),
    reference: secretSource.reference(),
    placeholder: text("placeholder").notNull().unique(),
    /** The value is an installation token minted from the bot's GitHub App, so no source column is set. */
    githubApp: integer("github_app", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.name] }),
    check(
      "agent_credentials_source",
      sql`(${table.githubApp} = 0 AND (${hasOneSecretSource(table)})) OR (${table.githubApp} = 1 AND ${table.value} IS NULL AND ${table.passwordManager} IS NULL AND ${table.reference} IS NULL)`,
    ),
  ],
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

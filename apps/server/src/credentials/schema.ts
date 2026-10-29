import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";
import { oneSecretSource, secretSource } from "../password-managers/schema";

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

export const agentCredentials = sqliteTable(
  "agent_credentials",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hosts: text("hosts").notNull(),
    value: secretSource.value(),
    passwordManager: secretSource.passwordManager(),
    reference: secretSource.reference(),
    placeholder: text("placeholder").notNull().unique(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.name] }),
    oneSecretSource("agent_credentials_source", table),
  ],
);

export const credentialAuthorities = sqliteTable("credential_authorities", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  certificate: text("certificate").notNull(),
  key: text("key").notNull(),
});

export const credentialRequests = sqliteTable(
  "credential_requests",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hosts: text("hosts").notNull(),
    reason: text("reason").notNull(),
    requestedAt: text("requested_at").notNull(),
  },
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

import {
  check,
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

/** The columns of an agent's named secret that only goes to `hosts`, a JSON list: a credential, or a login. */
export const hostBoundSecret = () => ({
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hosts: text("hosts").notNull(),
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

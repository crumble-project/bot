import { sql } from "drizzle-orm";
import {
  check,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import type { PasswordManagerId } from "../shared/domain";

/** The account's connected password managers, at most one per vendor. */
export const passwordManagers = sqliteTable(
  "password_managers",
  {
    id: text("id").$type<PasswordManagerId>().primaryKey(),
    /** The service account or access token, encrypted with the account's key. */
    token: text("token").notNull(),
    connectedAt: text("connected_at").notNull(),
  },
  (table) => [
    check(
      "password_managers_id",
      sql`${table.id} IN ('1password', 'bitwarden')`,
    ),
  ],
);

/**
 * Where a secret's value comes from: stored encrypted in `value`, or read from a password manager by `reference`.
 * Exactly one of the two is set; a password manager in use can't be removed.
 */
export const secretSource = {
  value: () => text("value"),
  passwordManager: () =>
    text("password_manager")
      .$type<PasswordManagerId>()
      .references(() => passwordManagers.id, { onDelete: "restrict" }),
  reference: () => text("reference"),
};

type SecretSourceColumns = {
  value: AnySQLiteColumn;
  passwordManager: AnySQLiteColumn;
  reference: AnySQLiteColumn;
};

/** True when a row has exactly one of a stored value and a password manager reference. */
export const hasOneSecretSource = (table: SecretSourceColumns) =>
  sql`(${table.value} IS NOT NULL AND ${table.passwordManager} IS NULL AND ${table.reference} IS NULL) OR (${table.value} IS NULL AND ${table.passwordManager} IS NOT NULL AND ${table.reference} IS NOT NULL)`;

/** The check a table with `secretSource` columns needs, so each row has one source. */
export const oneSecretSource = (name: string, table: SecretSourceColumns) =>
  check(name, hasOneSecretSource(table));

import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
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

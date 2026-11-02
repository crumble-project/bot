import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
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

import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { PasswordManagerId } from "../contract/secrets";

export const passwordManagers = sqliteTable(
  "password_managers",
  {
    id: text("id").$type<PasswordManagerId>().primaryKey(),
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

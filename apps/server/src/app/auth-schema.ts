import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The columns of Better Auth's user table that Crumble reads; Better Auth creates and migrates the table. */
export const authUsers = sqliteTable("user", {
  id: text().primaryKey(),
  email: text().notNull(),
});

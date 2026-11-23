import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const authUsers = sqliteTable("user", {
  id: text().primaryKey(),
  email: text().notNull(),
});

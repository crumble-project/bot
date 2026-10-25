import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    provider: text("provider").primaryKey(),
    type: text("type", { enum: ["api_key", "oauth"] }).notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    check(
      "provider_credentials_type",
      sql`${table.type} IN ('api_key', 'oauth')`,
    ),
  ],
);

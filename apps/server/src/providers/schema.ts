import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A provider's credential as Pi AI keeps it, encrypted; an API key's `key` is a secret of its own instead, so `value`
 * is null for an API key with no other fields.
 */
export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    provider: text("provider").primaryKey(),
    type: text("type", { enum: ["api_key", "oauth"] }).notNull(),
    value: text("value"),
  },
  (table) => [
    check(
      "provider_credentials_type",
      sql`${table.type} IN ('api_key', 'oauth')`,
    ),
  ],
);

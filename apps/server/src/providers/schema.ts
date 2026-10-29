import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { oneSecretSource, secretSource } from "../password-managers/schema";

export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    provider: text("provider").primaryKey(),
    type: text("type", { enum: ["api_key", "oauth"] }).notNull(),
    value: secretSource.value(),
    passwordManager: secretSource.passwordManager(),
    reference: secretSource.reference(),
  },
  (table) => [
    check(
      "provider_credentials_type",
      sql`${table.type} IN ('api_key', 'oauth')`,
    ),
    oneSecretSource("provider_credentials_source", table),
    // Crumble rewrites OAuth credentials when they refresh, which a read-only password manager can't hold.
    check(
      "provider_credentials_oauth_stored",
      sql`${table.type} = 'api_key' OR ${table.reference} IS NULL`,
    ),
  ],
);

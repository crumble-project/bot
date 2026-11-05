import { primaryKey, sqliteTable } from "drizzle-orm/sqlite-core";
import { hostBoundSecret } from "../bot-secrets/schema";

/** The logins the owner gave each bot; their fields are secrets, their requests and fills are in `bot-secrets`. */
export const logins = sqliteTable("logins", hostBoundSecret(), (table) => [
  primaryKey({ columns: [table.agentId, table.name] }),
]);

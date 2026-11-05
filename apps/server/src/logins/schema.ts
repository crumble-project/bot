import { primaryKey, sqliteTable } from "drizzle-orm/sqlite-core";
import { hostBoundSecret } from "../bot-secrets/schema";

export const logins = sqliteTable("logins", hostBoundSecret(), (table) => [
  primaryKey({ columns: [table.agentId, table.name] }),
]);

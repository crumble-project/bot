import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";
import { hostBoundSecret } from "../bot-secrets/schema";

export const agentCredentials = sqliteTable(
  "agent_credentials",
  {
    ...hostBoundSecret(),
    placeholder: text("placeholder").notNull().unique(),
    /** The value is a token from the bot's GitHub App; otherwise it is a secret under `credentialSecretKey`. */
    github: integer("github", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.name] })],
);

export const credentialAuthorities = sqliteTable("credential_authorities", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  certificate: text("certificate").notNull(),
  key: text("key").notNull(),
});

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  agentId: text("agent_id").references(() => agents.id, {
    onDelete: "cascade",
  }),
  oauthClientId: text("oauth_client_id"),
});

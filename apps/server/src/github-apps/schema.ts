import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";

/** The GitHub App each bot acts through on GitHub, created from a manifest; one per bot. */
export const agentGithubApps = sqliteTable("agent_github_apps", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  appId: integer("app_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  clientId: text("client_id").notNull(),
  /** The App's private key in PEM, encrypted with the account's key. */
  privateKey: text("private_key").notNull(),
  /** The `slug[bot]` user's ID, which GitHub's noreply commit email needs. */
  botUserId: integer("bot_user_id").notNull(),
  htmlUrl: text("html_url").notNull(),
  installationId: integer("installation_id"),
  /** The user or organization the App is installed on. */
  installedOn: text("installed_on"),
  createdAt: text("created_at").notNull(),
});

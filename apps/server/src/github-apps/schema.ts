import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { agents } from "../bots/schema";

/** The account's GitHub Apps, each created from a manifest and private to one GitHub account. */
export const githubApps = sqliteTable("github_apps", {
  id: text("id").primaryKey(),
  appId: integer("app_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  clientId: text("client_id").notNull(),
  /** The App's private key in PEM, encrypted with the account's key. */
  privateKey: text("private_key").notNull(),
  /** The `slug[bot]` user's ID, which GitHub's noreply commit email needs. */
  botUserId: integer("bot_user_id").notNull(),
  htmlUrl: text("html_url").notNull(),
  /** The GitHub user or organization whose repositories the App works on; null until known from an installation. */
  account: text("account"),
  installationId: integer("installation_id"),
  /** Encrypted; needed to sign the owner in through the App. Apps created before Crumble kept it have none until pasted. */
  clientSecret: text("client_secret"),
  createdAt: text("created_at").notNull(),
});

/** Which bots act through which App; a bot uses at most one App per GitHub account. */
export const githubAppBots = sqliteTable(
  "github_app_bots",
  {
    appId: text("app_id")
      .notNull()
      .references(() => githubApps.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    assignedAt: text("assigned_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.agentId] })],
);

/** The owner signed in through an App: its bots then act on GitHub as the owner, shown with the App's badge. */
export const githubAppUsers = sqliteTable("github_app_users", {
  appId: text("app_id")
    .primaryKey()
    .references(() => githubApps.id, { onDelete: "cascade" }),
  login: text("login").notNull(),
  userId: integer("user_id").notNull(),
  /** Encrypted, like `refreshToken`; GitHub rotates both on every refresh. */
  token: text("token").notNull(),
  expiresAt: integer("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  refreshExpiresAt: integer("refresh_expires_at").notNull(),
});

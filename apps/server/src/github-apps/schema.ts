import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { agents } from "../bot-store/schema";

export const githubApps = sqliteTable("github_apps", {
  id: text("id").primaryKey(),
  appId: integer("app_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  clientId: text("client_id").notNull(),
  privateKey: text("private_key").notNull(),
  /** The `slug[bot]` user's ID, which GitHub's noreply commit email needs. */
  botUserId: integer("bot_user_id").notNull(),
  htmlUrl: text("html_url").notNull(),
  account: text("account"),
  installationId: integer("installation_id"),
  createdAt: text("created_at").notNull(),
});

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

export const githubAccounts = sqliteTable("github_accounts", {
  id: text("id").primaryKey(),
  login: text("login").notNull(),
  userId: integer("user_id").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const githubAccountBots = sqliteTable("github_account_bots", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  accountId: text("account_id")
    .notNull()
    .references(() => githubAccounts.id, { onDelete: "cascade" }),
  assignedAt: text("assigned_at").notNull(),
});

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { agents } from "../bots/schema";

/** The secrets a bot can be given for named hosts: credentials and logins. */
export const BOT_SECRET_KINDS = ["credential", "login"] as const;

export type BotSecretKind = (typeof BOT_SECRET_KINDS)[number];

const kind = () =>
  text("kind", { enum: BOT_SECRET_KINDS }).$type<BotSecretKind>().notNull();

const agentId = () =>
  text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" });

/** The columns of an agent's named secret that only goes to `hosts`, a JSON list: a credential, or a login. */
export const hostBoundSecret = () => ({
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hosts: text("hosts").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

const hostList = z.array(z.string());

/** The hosts of a `hosts` column. */
export const parseHosts = (hosts: string) => hostList.parse(JSON.parse(hosts));

const kindCheck = (name: string, column: AnySQLiteColumn) =>
  check(name, sql`${column} IN ('credential', 'login')`);

/** A bot's request for a credential or login, waiting for the owner; one per bot, kind, and name. */
export const botSecretRequests = sqliteTable(
  "bot_secret_requests",
  {
    agentId: agentId(),
    kind: kind(),
    name: text("name").notNull(),
    /** A JSON list. */
    hosts: text("hosts").notNull(),
    reason: text("reason").notNull(),
    /** Logins only: the site asks for a one-time code too. */
    oneTimeCode: integer("one_time_code", { mode: "boolean" })
      .notNull()
      .default(false),
    requestedAt: text("requested_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.kind, table.name] }),
    kindCheck("bot_secret_requests_kind", table.kind),
  ],
);

/** Each use of a credential or login; `detail` holds what the kind records, as JSON. */
export const botSecretUses = sqliteTable(
  "bot_secret_uses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: agentId(),
    kind: kind(),
    name: text("name").notNull(),
    at: text("at").notNull(),
    host: text("host").notNull(),
    /** Why the value couldn't be read from its password manager; nothing was sent or typed. */
    error: text("error"),
    detail: text("detail").notNull(),
  },
  (table) => [
    kindCheck("bot_secret_uses_kind", table.kind),
    index("bot_secret_uses_by_secret").on(
      table.agentId,
      table.kind,
      table.name,
      table.id,
    ),
    index("bot_secret_uses_by_time").on(table.at),
  ],
);

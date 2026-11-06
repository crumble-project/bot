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
import { agents } from "../bot-store/schema";

export const BOT_SECRET_KINDS = ["credential", "login"] as const;

export type BotSecretKind = (typeof BOT_SECRET_KINDS)[number];

const kind = () =>
  text("kind", { enum: BOT_SECRET_KINDS }).$type<BotSecretKind>().notNull();

const agentId = () =>
  text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" });

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

export const parseHosts = (hosts: string) => hostList.parse(JSON.parse(hosts));

const kindCheck = (name: string, column: AnySQLiteColumn) =>
  check(name, sql`${column} IN ('credential', 'login')`);

export const botSecretRequests = sqliteTable(
  "bot_secret_requests",
  {
    agentId: agentId(),
    kind: kind(),
    name: text("name").notNull(),
    hosts: text("hosts").notNull(),
    reason: text("reason").notNull(),
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

export const botSecretUses = sqliteTable(
  "bot_secret_uses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: agentId(),
    kind: kind(),
    name: text("name").notNull(),
    at: text("at").notNull(),
    host: text("host").notNull(),
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

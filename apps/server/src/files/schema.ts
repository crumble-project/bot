import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { agents } from "../bot-store/schema";
import { groupChats } from "../group-chats/schema";

export const deletedLibraryFiles = sqliteTable(
  "deleted_library_files",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    groupId: text("group_id").references(() => groupChats.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
  },
  (table) => [
    check(
      "deleted_library_files_one_owner",
      sql`(${table.agentId} IS NOT NULL) != (${table.groupId} IS NOT NULL)`,
    ),
  ],
);

export const libraryFiles = sqliteTable(
  "library_files",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    groupId: text("group_id").references(() => groupChats.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    hash: text("hash").notNull(),
    text: text("text", { enum: ["none", "extracted", "failed"] }).notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check(
      "library_files_one_owner",
      sql`(${table.agentId} IS NOT NULL) != (${table.groupId} IS NOT NULL)`,
    ),
    uniqueIndex("library_files_bot_hash").on(table.agentId, table.hash),
    uniqueIndex("library_files_group_hash").on(table.groupId, table.hash),
  ],
);

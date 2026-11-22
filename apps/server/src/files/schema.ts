import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { agents } from "../bot-store/schema";

export const deletedLibraryFiles = sqliteTable("deleted_library_files", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
});

export const libraryFiles = sqliteTable(
  "library_files",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    hash: text("hash").notNull(),
    text: text("text", { enum: ["none", "extracted", "failed"] }).notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("library_files_bot_hash").on(table.agentId, table.hash),
  ],
);

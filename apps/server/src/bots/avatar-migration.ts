import { Effect } from "effect";
import { and, eq, isNull } from "drizzle-orm";
import type { SqliteDatabase } from "../shared/database";
import {
  avatarDefinitionSchema,
  legacyAvatarDefinition,
} from "../contract/avatar";
import { agents } from "./schema";

/** Restartable backfill after schema migration, before the account serves bots. Old binaries may also leave missing definitions. */
export const migrateAvatars = Effect.fn("migrateAvatars")(function* (
  db: SqliteDatabase,
) {
  for (const row of yield* db
    .select()
    .from(agents)
    .where(isNull(agents.avatarDefinition))) {
    const definition = avatarDefinitionSchema.parse(
      legacyAvatarDefinition(row),
    );

    // Never overwrite an imported definition or touch the legacy native seed or timestamps.
    yield* db
      .update(agents)
      .set({ avatarDefinition: JSON.stringify(definition) })
      .where(and(eq(agents.id, row.id), isNull(agents.avatarDefinition)));
  }
});

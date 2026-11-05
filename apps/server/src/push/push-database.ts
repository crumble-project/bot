import { join } from "node:path";
import { Context, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  migrationsFolder,
  sqliteDatabase,
  type SqliteDatabase,
} from "../shared/database";

export class PushDatabase extends Context.Service<
  PushDatabase,
  SqliteDatabase
>()("crumble/push/PushDatabase") {
  static layer(dataDir: string) {
    return Layer.effect(
      PushDatabase,
      sqliteDatabase(migrationsFolder("push")),
    ).pipe(
      Layer.provide(
        SqliteClient.layer({ filename: join(dataDir, "push.sqlite") }),
      ),
    );
  }
}

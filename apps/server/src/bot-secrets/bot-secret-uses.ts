import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { Clock, Context, Effect, Layer } from "effect";
import { BOT_SECRET_USE_RETENTION_DAYS } from "../contract/limits";
import { ProductDatabase } from "../shared/product-database";
import { pruneHourly, startTicking } from "../shared/ticker";
import { botSecretUses, type BotSecretKind } from "./schema";

export const BOT_SECRET_USE_RETENTION_MS =
  BOT_SECRET_USE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type BotSecretUse = {
  id: string;
  at: string;
  host: string;
  error: string | null;
  detail: unknown;
};

export const lastUseError = (
  kind: BotSecretKind,
  owner: { agentId: AnySQLiteColumn; name: AnySQLiteColumn },
) =>
  sql<
    string | null
  >`(SELECT ${botSecretUses.error} FROM ${botSecretUses} WHERE ${botSecretUses.agentId} = ${owner.agentId} AND ${botSecretUses.kind} = ${kind} AND ${botSecretUses.name} = ${owner.name} ORDER BY ${botSecretUses.id} DESC LIMIT 1)`;

export class BotSecretUses extends Context.Service<
  BotSecretUses,
  {
    readonly record: (
      agentId: string,
      kind: BotSecretKind,
      name: string,
      use: Omit<BotSecretUse, "id">,
    ) => Effect.Effect<void>;
    /** Newest first; page with `before` set to the last use's ID. */
    readonly list: (
      agentId: string,
      kind: BotSecretKind,
      name: string,
      options: { limit: number; before?: string | undefined },
    ) => Effect.Effect<BotSecretUse[]>;
    readonly forget: (
      agentId: string,
      kind: BotSecretKind,
      name: string,
    ) => Effect.Effect<void>;
  }
>()("crumble/bot-secrets/BotSecretUses") {
  static readonly layer = Layer.effect(
    BotSecretUses,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const of = (agentId: string, kind: BotSecretKind, name: string) =>
        and(
          eq(botSecretUses.agentId, agentId),
          eq(botSecretUses.kind, kind),
          eq(botSecretUses.name, name),
        );

      return BotSecretUses.of({
        record: Effect.fn("BotSecretUses.record")(function* (
          agentId,
          kind,
          name,
          use,
        ) {
          yield* db.insert(botSecretUses).values({
            agentId,
            kind,
            name,
            at: use.at,
            host: use.host,
            error: use.error,
            detail: JSON.stringify(use.detail),
          });
        }, Effect.orDie),
        list: Effect.fn("BotSecretUses.list")(
          function* (agentId, kind, name, options) {
            const cursor = Number(options.before);

            const rows = yield* db
              .select()
              .from(botSecretUses)
              .where(
                and(
                  of(agentId, kind, name),
                  lt(
                    botSecretUses.id,
                    Number.isSafeInteger(cursor) && cursor > 0
                      ? cursor
                      : Number.MAX_SAFE_INTEGER,
                  ),
                ),
              )
              .orderBy(desc(botSecretUses.id))
              .limit(options.limit)
              .pipe(Effect.orDie);

            return rows.map((row) => ({
              id: String(row.id),
              at: row.at,
              host: row.host,
              error: row.error,
              detail: JSON.parse(row.detail),
            }));
          },
        ),
        forget: Effect.fn("BotSecretUses.forget")(function* (
          agentId,
          kind,
          name,
        ) {
          yield* db.delete(botSecretUses).where(of(agentId, kind, name));
        }, Effect.orDie),
      });
    }),
  );
}

export const botSecretUseRetention = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* ProductDatabase;

    const prune = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoff = new Date(now - BOT_SECRET_USE_RETENTION_MS);

      yield* db
        .delete(botSecretUses)
        .where(lt(botSecretUses.at, cutoff.toISOString()));
    }).pipe(Effect.orDie);

    yield* startTicking(pruneHourly(prune), yield* Effect.scope);
  }),
);

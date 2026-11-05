import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { BotNotices, requestAnswers } from "../bots/bot-notices";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { botSecretRequests, parseHosts, type BotSecretKind } from "./schema";

/** A bot's request for a credential or login, waiting for the owner. */
export type BotSecretRequest = {
  name: string;
  hosts: string[];
  reason: string;
  /** Logins only: the site asks for a one-time code too. */
  oneTimeCode: boolean;
  requestedAt: string;
};

const requestOf = (
  row: typeof botSecretRequests.$inferSelect,
): BotSecretRequest => ({
  name: row.name,
  hosts: parseHosts(row.hosts),
  reason: row.reason,
  oneTimeCode: row.oneTimeCode,
  requestedAt: row.requestedAt,
});

/** Bots asking the owner for a credential or login, answered by saving it or declining; the bot is told either way. */
export class BotSecretRequests extends Context.Service<
  BotSecretRequests,
  {
    readonly list: (
      agentId: string,
      kind: BotSecretKind,
    ) => Effect.Effect<BotSecretRequest[]>;
    readonly get: (
      agentId: string,
      kind: BotSecretKind,
      name: string,
    ) => Effect.Effect<BotSecretRequest | undefined>;
    /** A repeated request replaces the earlier one. */
    readonly ask: (
      agentId: string,
      kind: BotSecretKind,
      input: {
        name: string;
        hosts: string[];
        reason: string;
        oneTimeCode?: boolean | undefined;
      },
    ) => Effect.Effect<BotSecretRequest>;
    /** Clears the request a save answered and tells the bot `text`; nothing happens without a request. */
    readonly answer: (
      agentId: string,
      kind: BotSecretKind,
      name: string,
      text: string,
    ) => Effect.Effect<void>;
    /** Clears the request and tells the bot; false when there was none. */
    readonly decline: (
      agentId: string,
      kind: BotSecretKind,
      name: string,
    ) => Effect.Effect<boolean>;
  }
>()("crumble/bot-secrets/BotSecretRequests") {
  static readonly layer = Layer.effect(
    BotSecretRequests,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const notices = yield* BotNotices;

      const where = (agentId: string, kind: BotSecretKind, name: string) =>
        and(
          eq(botSecretRequests.agentId, agentId),
          eq(botSecretRequests.kind, kind),
          eq(botSecretRequests.name, name),
        );

      const get = Effect.fn("BotSecretRequests.get")(function* (
        agentId: string,
        kind: BotSecretKind,
        name: string,
      ) {
        const [row] = yield* db
          .select()
          .from(botSecretRequests)
          .where(where(agentId, kind, name));

        return row && requestOf(row);
      }, Effect.orDie);

      /** Deletes the request and tells the bot; false when there was none. */
      const close = Effect.fnUntraced(function* (
        agentId: string,
        kind: BotSecretKind,
        name: string,
        text: string,
      ) {
        const deleted = yield* db
          .delete(botSecretRequests)
          .where(where(agentId, kind, name))
          .returning({ name: botSecretRequests.name })
          .pipe(Effect.orDie);

        if (!deleted.length) return false;

        yield* requestAnswers(notices, kind)(agentId, name, text);

        return true;
      });

      return BotSecretRequests.of({
        list: Effect.fn("BotSecretRequests.list")(function* (agentId, kind) {
          const rows = yield* db
            .select()
            .from(botSecretRequests)
            .where(
              and(
                eq(botSecretRequests.agentId, agentId),
                eq(botSecretRequests.kind, kind),
              ),
            )
            .orderBy(asc(botSecretRequests.requestedAt));

          return rows.map(requestOf);
        }, Effect.orDie),
        get,
        ask: Effect.fn("BotSecretRequests.ask")(
          function* (agentId, kind, input) {
            const row = {
              hosts: JSON.stringify(input.hosts),
              reason: input.reason,
              oneTimeCode: input.oneTimeCode ?? false,
              requestedAt: yield* nowIso,
            };

            yield* db
              .insert(botSecretRequests)
              .values({ agentId, kind, name: input.name, ...row })
              .onConflictDoUpdate({
                target: [
                  botSecretRequests.agentId,
                  botSecretRequests.kind,
                  botSecretRequests.name,
                ],
                set: row,
              })
              .pipe(Effect.orDie);

            return (yield* get(agentId, kind, input.name))!;
          },
        ),
        answer: (agentId, kind, name, text) =>
          Effect.asVoid(close(agentId, kind, name, text)),
        decline: (agentId, kind, name) =>
          close(
            agentId,
            kind,
            name,
            `The owner declined your request for ${kind} ${name}.`,
          ),
      });
    }),
  );
}

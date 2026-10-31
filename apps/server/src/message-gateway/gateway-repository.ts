import { and, count, eq, gt, isNull, lte, max, ne, or, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";
import { ProductDatabase } from "../shared/product-database";
import {
  gatewayCooldowns,
  gatewayReceipts,
  gatewaySentMessages,
} from "./schema";

export type GatewayReceipt = typeof gatewayReceipts.$inferSelect;

export type GatewayReceiptInput = typeof gatewayReceipts.$inferInsert;

export const GATEWAY_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
export const GATEWAY_HISTORY_RETENTION_MS = 30 * GATEWAY_RECEIPT_TTL_MS;

export class GatewayRepository extends Context.Service<
  GatewayRepository,
  {
    readonly insert: (receipt: GatewayReceiptInput) => Effect.Effect<boolean>;
    readonly save: (receipt: GatewayReceipt) => Effect.Effect<void>;
    readonly pending: Effect.Effect<GatewayReceipt[]>;
    readonly failedCount: (adapterId: string) => Effect.Effect<number>;
    readonly cooldown: (
      adapterId: string,
      channelId: string,
    ) => Effect.Effect<number>;
    readonly defer: (
      adapterId: string,
      channelId: string | null,
      until: number,
    ) => Effect.Effect<void>;
    readonly pruneGatewayHistory: (now: number) => Effect.Effect<void>;
    readonly replyBot: (
      adapterId: string,
      channelId: string,
      messageId: string,
    ) => Effect.Effect<string | null>;
  }
>()("crumble/message-gateway/GatewayRepository") {
  static readonly layer = Layer.effect(
    GatewayRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const insert = Effect.fn("GatewayRepository.insert")(function* (
        receipt: GatewayReceiptInput,
      ) {
        const now = yield* Clock.currentTimeMillis;

        const rows = yield* db
          .insert(gatewayReceipts)
          .values({
            ...receipt,
            createdAt: receipt.createdAt ?? now,
            expiresAt: receipt.expiresAt ?? now + GATEWAY_RECEIPT_TTL_MS,
          })
          .onConflictDoNothing()
          .returning({ id: gatewayReceipts.messageId });

        return rows.length > 0;
      }, Effect.orDie);

      const save = Effect.fn("GatewayRepository.save")(function* (
        receipt: GatewayReceipt,
      ) {
        const terminal = receipt.state !== "pending";

        const finishedAt = terminal
          ? (receipt.finishedAt ??
            receipt.failedAt ??
            (yield* Clock.currentTimeMillis))
          : null;

        const expiresAt =
          finishedAt === null
            ? null
            : finishedAt + GATEWAY_HISTORY_RETENTION_MS;

        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(gatewayReceipts)
              .set(
                terminal
                  ? {
                      ...receipt,
                      text: "",
                      chunks: null,
                      sent: [],
                      nextAttemptAt: null,
                      finishedAt,
                    }
                  : receipt,
              )
              .where(
                and(
                  eq(gatewayReceipts.adapterId, receipt.adapterId),
                  eq(gatewayReceipts.messageId, receipt.messageId),
                ),
              );

            if (receipt.botId && receipt.sent.length) {
              yield* tx
                .insert(gatewaySentMessages)
                .values(
                  receipt.sent.map((externalMessageId) => ({
                    adapterId: receipt.adapterId,
                    channelId: receipt.channelId,
                    externalMessageId,
                    receiptMessageId: receipt.messageId,
                    botId: receipt.botId!,
                    expiresAt,
                  })),
                )
                .onConflictDoNothing();
            }

            if (terminal) {
              yield* tx
                .update(gatewaySentMessages)
                .set({ expiresAt })
                .where(
                  and(
                    eq(gatewaySentMessages.adapterId, receipt.adapterId),
                    eq(gatewaySentMessages.receiptMessageId, receipt.messageId),
                  ),
                );
            }
          }),
        );
      }, Effect.orDie);

      const pending = db
        .select()
        .from(gatewayReceipts)
        .where(eq(gatewayReceipts.state, "pending"))
        .pipe(Effect.orDie);

      const failedCount = Effect.fn("GatewayRepository.failedCount")(function* (
        adapterId: string,
      ) {
        const [row] = yield* db
          .select({ count: count() })
          .from(gatewayReceipts)
          .where(
            and(
              eq(gatewayReceipts.adapterId, adapterId),
              eq(gatewayReceipts.state, "failed"),
            ),
          );

        return row?.count ?? 0;
      }, Effect.orDie);

      const pruneGatewayHistory = Effect.fn(
        "GatewayRepository.pruneGatewayHistory",
      )(function* (now: number) {
        yield* db
          .delete(gatewayReceipts)
          .where(
            and(
              ne(gatewayReceipts.state, "pending"),
              lte(
                gatewayReceipts.finishedAt,
                now - GATEWAY_HISTORY_RETENTION_MS,
              ),
            ),
          );
        yield* db
          .delete(gatewayCooldowns)
          .where(lte(gatewayCooldowns.until, now));
      }, Effect.orDie);

      const cooldown = Effect.fn("GatewayRepository.cooldown")(function* (
        adapterId: string,
        channelId: string,
      ) {
        const [row] = yield* db
          .select({ until: max(gatewayCooldowns.until) })
          .from(gatewayCooldowns)
          .where(
            and(
              eq(gatewayCooldowns.adapterId, adapterId),
              or(
                eq(gatewayCooldowns.scope, "adapter"),
                and(
                  eq(gatewayCooldowns.scope, "channel"),
                  eq(gatewayCooldowns.channelId, channelId),
                ),
              ),
            ),
          );

        return row?.until ?? 0;
      }, Effect.orDie);

      const defer = Effect.fn("GatewayRepository.defer")(function* (
        adapterId: string,
        channelId: string | null,
        until: number,
      ) {
        yield* db
          .insert(gatewayCooldowns)
          .values({
            adapterId,
            scope: channelId === null ? "adapter" : "channel",
            channelId: channelId ?? "",
            until,
          })
          .onConflictDoUpdate({
            target: [
              gatewayCooldowns.adapterId,
              gatewayCooldowns.scope,
              gatewayCooldowns.channelId,
            ],
            set: { until: sql`max(${gatewayCooldowns.until}, ${until})` },
          });
      }, Effect.orDie);

      const replyBot = Effect.fn("GatewayRepository.replyBot")(function* (
        adapterId: string,
        channelId: string,
        messageId: string,
      ) {
        const [row] = yield* db
          .select({ botId: gatewaySentMessages.botId })
          .from(gatewaySentMessages)
          .where(
            and(
              eq(gatewaySentMessages.adapterId, adapterId),
              eq(gatewaySentMessages.channelId, channelId),
              eq(gatewaySentMessages.externalMessageId, messageId),
              or(
                isNull(gatewaySentMessages.expiresAt),
                gt(
                  gatewaySentMessages.expiresAt,
                  yield* Clock.currentTimeMillis,
                ),
              ),
            ),
          )
          .limit(1);

        return row?.botId ?? null;
      }, Effect.orDie);

      return GatewayRepository.of({
        insert,
        save,
        pending,
        failedCount,
        cooldown,
        defer,
        replyBot,
        pruneGatewayHistory,
      });
    }),
  );
}

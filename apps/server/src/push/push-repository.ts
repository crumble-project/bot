import { and, asc, eq, lte } from "drizzle-orm";
import { Clock, Context, DateTime, Effect, Layer, Option } from "effect";
import { PushDatabase } from "./push-database";
import type { PushDevice, PushDeviceInput, ReplyPushEvent } from "./push-model";
import {
  pushDelivery,
  pushDevices,
  pushOutbox,
  pushPresence,
  pushSettings,
} from "./schema";

/** A delivery due now: one event for one device. */
export type PendingDelivery = {
  readonly outboxId: string;
  readonly installationId: string;
  readonly eventJson: string;
  readonly expiresAt: number;
  readonly attempts: number;
};

// A presence report counts for two minutes; clients refresh it while a chat is visible.
const PRESENCE_TTL_MS = 120_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const deviceOf = (row: typeof pushDevices.$inferSelect): PushDevice => {
  const device: PushDevice = {
    installationId: row.installationId,
    platform: row.platform,
    transport: row.transport,
    token: row.token,
    environment: row.environment,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  };

  if (row.bundleId) device.bundleId = row.bundleId;

  return device;
};

/** Devices, presence, and the delivery outbox of an account's push database. */
export class PushRepository extends Context.Service<
  PushRepository,
  {
    /** The server's push identity, created on first use and kept from then on. */
    readonly serverId: Effect.Effect<string>;
    readonly upsertDevice: (
      installationId: string,
      input: PushDeviceInput,
    ) => Effect.Effect<PushDevice>;
    readonly getDevice: (
      installationId: string,
    ) => Effect.Effect<Option.Option<PushDevice>>;
    readonly deleteDevice: (installationId: string) => Effect.Effect<void>;
    /** False when the device is not registered. */
    readonly setPresence: (
      installationId: string,
      active: boolean,
      agentId: string | null,
    ) => Effect.Effect<boolean>;
    /** Whether the device shows this bot's chat now, so a reply there needs no notification. */
    readonly isSuppressed: (
      installationId: string,
      agentId: string,
    ) => Effect.Effect<boolean>;
    readonly enqueue: (
      event: ReplyPushEvent,
      ttlMs?: number,
    ) => Effect.Effect<void>;
    readonly pending: (
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<PendingDelivery>>;
    readonly markDelivered: (
      outboxId: string,
      installationId: string,
    ) => Effect.Effect<void>;
    readonly markRetry: (
      outboxId: string,
      installationId: string,
      attempts: number,
      nextAttemptAt: number,
    ) => Effect.Effect<void>;
    readonly removeDelivery: (
      outboxId: string,
      installationId: string,
    ) => Effect.Effect<void>;
    /** Starts the delivery over, with fresh attempts, for a device whose token changed. */
    readonly requeueDelivery: (
      outboxId: string,
      installationId: string,
    ) => Effect.Effect<void>;
    readonly disableIfToken: (
      installationId: string,
      token: string,
    ) => Effect.Effect<void>;
    /** Drops expired events and, with them, their deliveries. */
    readonly cleanup: Effect.Effect<void>;
  }
>()("crumble/push/PushRepository") {
  static readonly layerNoDeps = Layer.effect(
    PushRepository,
    Effect.gen(function* () {
      const db = yield* PushDatabase;

      const serverId = Effect.gen(function* () {
        const [row] = yield* db
          .select({ value: pushSettings.value })
          .from(pushSettings)
          .where(eq(pushSettings.key, "server_id"));

        if (row) return row.value;

        const value = crypto.randomUUID();
        yield* db.insert(pushSettings).values({ key: "server_id", value });

        return value;
      }).pipe(Effect.orDie, Effect.withSpan("PushRepository.serverId"));

      const getDevice = Effect.fn("PushRepository.getDevice")(function* (
        installationId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(pushDevices)
          .where(eq(pushDevices.installationId, installationId));

        return Option.map(Option.fromNullishOr(row), deviceOf);
      }, Effect.orDie);

      const upsertDevice = Effect.fn("PushRepository.upsertDevice")(function* (
        installationId: string,
        input: PushDeviceInput,
      ) {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);

        const values = {
          platform: input.platform,
          transport: input.transport,
          token: input.token,
          environment: input.environment,
          bundleId: input.bundleId ?? null,
          enabled: input.enabled,
          updatedAt,
        };

        yield* db
          .insert(pushDevices)
          .values({ installationId, ...values })
          .onConflictDoUpdate({
            target: pushDevices.installationId,
            set: values,
          });

        // Registration never resets a lease; first registration starts inactive.
        yield* db
          .insert(pushPresence)
          .values({
            installationId,
            active: false,
            agentId: null,
            refreshedAt: yield* Clock.currentTimeMillis,
          })
          .onConflictDoNothing();

        return Option.getOrThrow(yield* getDevice(installationId));
      }, Effect.orDie);

      const deleteDevice = Effect.fn("PushRepository.deleteDevice")(function* (
        installationId: string,
      ) {
        yield* db
          .delete(pushDevices)
          .where(eq(pushDevices.installationId, installationId));
      }, Effect.orDie);

      const setPresence = Effect.fn("PushRepository.setPresence")(function* (
        installationId: string,
        active: boolean,
        agentId: string | null,
      ) {
        if (Option.isNone(yield* getDevice(installationId))) return false;

        const presence = {
          active,
          agentId,
          refreshedAt: yield* Clock.currentTimeMillis,
        };

        yield* db
          .insert(pushPresence)
          .values({ installationId, ...presence })
          .onConflictDoUpdate({
            target: pushPresence.installationId,
            set: presence,
          });

        return true;
      }, Effect.orDie);

      const isSuppressed = Effect.fn("PushRepository.isSuppressed")(function* (
        installationId: string,
        agentId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(pushPresence)
          .where(eq(pushPresence.installationId, installationId));

        return (
          !!row?.active &&
          row.agentId === agentId &&
          (yield* Clock.currentTimeMillis) - row.refreshedAt <= PRESENCE_TTL_MS
        );
      }, Effect.orDie);

      const enqueue = Effect.fn("PushRepository.enqueue")(function* (
        event: ReplyPushEvent,
        ttlMs: number = DAY_MS,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const createdAt = DateTime.formatIso(yield* DateTime.now);

        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(pushOutbox)
              .values({
                id: crypto.randomUUID(),
                eventId: event.eventId,
                eventJson: JSON.stringify(event),
                createdAt,
                expiresAt: now + ttlMs,
              })
              .onConflictDoNothing();

            // An event enqueued twice keeps its first outbox row.
            const [outbox] = yield* tx
              .select({ id: pushOutbox.id })
              .from(pushOutbox)
              .where(eq(pushOutbox.eventId, event.eventId));

            const devices = yield* tx
              .select({ installationId: pushDevices.installationId })
              .from(pushDevices)
              .where(eq(pushDevices.enabled, true));

            if (!outbox || !devices.length) return;

            yield* tx
              .insert(pushDelivery)
              .values(
                devices.map((device) => ({
                  outboxId: outbox.id,
                  installationId: device.installationId,
                  nextAttemptAt: now,
                })),
              )
              .onConflictDoNothing();
          }),
        );
      }, Effect.orDie);

      const pending = Effect.fn("PushRepository.pending")(function* (
        limit: number = 100,
      ) {
        return yield* db
          .select({
            outboxId: pushDelivery.outboxId,
            installationId: pushDelivery.installationId,
            eventJson: pushOutbox.eventJson,
            expiresAt: pushOutbox.expiresAt,
            attempts: pushDelivery.attempts,
          })
          .from(pushDelivery)
          .innerJoin(pushOutbox, eq(pushOutbox.id, pushDelivery.outboxId))
          .innerJoin(
            pushDevices,
            eq(pushDevices.installationId, pushDelivery.installationId),
          )
          .where(
            and(
              eq(pushDelivery.delivered, false),
              lte(pushDelivery.nextAttemptAt, yield* Clock.currentTimeMillis),
              eq(pushDevices.enabled, true),
            ),
          )
          .orderBy(asc(pushDelivery.nextAttemptAt))
          .limit(limit);
      }, Effect.orDie);

      const delivery = (outboxId: string, installationId: string) =>
        and(
          eq(pushDelivery.outboxId, outboxId),
          eq(pushDelivery.installationId, installationId),
        );

      const markDelivered = Effect.fn("PushRepository.markDelivered")(
        function* (outboxId: string, installationId: string) {
          yield* db
            .update(pushDelivery)
            .set({ delivered: true })
            .where(delivery(outboxId, installationId));
        },
        Effect.orDie,
      );

      const markRetry = Effect.fn("PushRepository.markRetry")(function* (
        outboxId: string,
        installationId: string,
        attempts: number,
        nextAttemptAt: number,
      ) {
        yield* db
          .update(pushDelivery)
          .set({ attempts, nextAttemptAt })
          .where(delivery(outboxId, installationId));
      }, Effect.orDie);

      const removeDelivery = Effect.fn("PushRepository.removeDelivery")(
        function* (outboxId: string, installationId: string) {
          yield* db
            .delete(pushDelivery)
            .where(delivery(outboxId, installationId));
        },
        Effect.orDie,
      );

      const requeueDelivery = Effect.fn("PushRepository.requeueDelivery")(
        function* (outboxId: string, installationId: string) {
          const fresh = {
            attempts: 0,
            nextAttemptAt: yield* Clock.currentTimeMillis,
            delivered: false,
          };

          yield* db
            .insert(pushDelivery)
            .values({ outboxId, installationId, ...fresh })
            .onConflictDoUpdate({
              target: [pushDelivery.outboxId, pushDelivery.installationId],
              set: fresh,
            });
        },
        Effect.orDie,
      );

      const disableIfToken = Effect.fn("PushRepository.disableIfToken")(
        function* (installationId: string, token: string) {
          yield* db
            .update(pushDevices)
            .set({ enabled: false })
            .where(
              and(
                eq(pushDevices.installationId, installationId),
                eq(pushDevices.token, token),
              ),
            );
        },
        Effect.orDie,
      );

      const cleanup = Effect.gen(function* () {
        yield* db
          .delete(pushOutbox)
          .where(lte(pushOutbox.expiresAt, yield* Clock.currentTimeMillis));
      }).pipe(Effect.orDie, Effect.withSpan("PushRepository.cleanup"));

      return PushRepository.of({
        serverId,
        upsertDevice,
        getDevice,
        deleteDevice,
        setPresence,
        isSuppressed,
        enqueue,
        pending,
        markDelivered,
        markRetry,
        removeDelivery,
        requeueDelivery,
        disableIfToken,
        cleanup,
      });
    }),
  );

  static layer(dataDir: string) {
    return this.layerNoDeps.pipe(Layer.provide(PushDatabase.layer(dataDir)));
  }
}

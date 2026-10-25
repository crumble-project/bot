import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Queue,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import type { Runner } from "../shared/runner";
import { BotActivity } from "../bots/bot-activity";
import type { ReplyActivity } from "../bots/bots";
import {
  canonicalReplyEvent,
  ReplyPushEvent,
  type PushDevice,
  type PushDeviceInput,
} from "./push-model";
import { PushRepository, type PendingDelivery } from "./push-repository";
import { PushTransports, type PushTransport } from "./push-transports";

export type PushRegistration = {
  readonly serverId: string;
  readonly remoteDelivery: boolean;
};

const MAX_ATTEMPTS = 7;

const MAX_BACKOFF_MS = 300_000;

const decodeEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ReplyPushEvent),
);

/** Notifies the owner's devices of replies, through the persisted outbox. */
export class Push extends Context.Service<
  Push,
  {
    readonly serverId: string;
    /** Which transports this server is configured for. */
    readonly transports: { readonly apns: boolean; readonly fcm: boolean };
    readonly device: (
      installationId: string,
      input: PushDeviceInput,
    ) => Effect.Effect<PushRegistration>;
    readonly remove: (installationId: string) => Effect.Effect<void>;
    /** False when the device is not registered. */
    readonly presence: (
      installationId: string,
      active: boolean,
      agentId: string | null,
    ) => Effect.Effect<boolean>;
    /** Queues a reply for every enabled device. */
    readonly enqueue: (activity: ReplyActivity) => Effect.Effect<void>;
    /** One delivery pass over what is due; passes run one at a time and finish once started. */
    readonly drain: Effect.Effect<void>;
  }
>()("crumble/push/Push") {
  static readonly layerNoDeps = Layer.effect(
    Push,
    Effect.gen(function* () {
      const repository = yield* PushRepository;
      const transports = yield* PushTransports;
      const serverId = yield* repository.serverId;
      const passes = yield* Semaphore.make(1);

      /** One delivery attempt, settled in the outbox; every failure kind decides its own outcome. */
      const send = Effect.fn("Push.send")(function* (
        transport: PushTransport,
        row: PendingDelivery,
        device: PushDevice,
        event: ReplyPushEvent,
      ) {
        const terminal = Effect.gen(function* () {
          yield* repository.removeDelivery(row.outboxId, device.installationId);
          yield* Effect.logWarning(
            "Push delivery reached a terminal provider state",
            device.transport,
          );
        });

        yield* transport.send(device, event).pipe(
          Effect.flatMap((result) =>
            result === "delivered"
              ? repository.markDelivered(row.outboxId, device.installationId)
              : terminal,
          ),
          Effect.catchTags({
            PermanentRejection: () =>
              Effect.gen(function* () {
                const current = yield* repository.getDevice(
                  device.installationId,
                );

                if (Option.isNone(current))
                  return yield* repository.removeDelivery(
                    row.outboxId,
                    device.installationId,
                  );

                // A token that rotated since the send gets the delivery again; the old one is disabled.
                if (current.value.token !== device.token)
                  return yield* repository.requeueDelivery(
                    row.outboxId,
                    device.installationId,
                  );

                yield* repository.disableIfToken(
                  device.installationId,
                  device.token,
                );
                yield* repository.removeDelivery(
                  row.outboxId,
                  device.installationId,
                );
              }),
            TerminalResponse: () => terminal,
            TemporaryFailure: () =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;

                if (row.attempts >= MAX_ATTEMPTS || row.expiresAt <= now)
                  return yield* repository.removeDelivery(
                    row.outboxId,
                    device.installationId,
                  );

                yield* repository.markRetry(
                  row.outboxId,
                  device.installationId,
                  row.attempts + 1,
                  now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** row.attempts),
                );
              }),
          }),
        );
      });

      const pass = Effect.gen(function* () {
        for (const row of yield* repository.pending()) {
          const found = yield* repository.getDevice(row.installationId);

          if (Option.isNone(found)) continue;
          const device = found.value;

          if (row.expiresAt <= (yield* Clock.currentTimeMillis)) {
            yield* repository.removeDelivery(
              row.outboxId,
              device.installationId,
            );
            continue;
          }

          const event = yield* decodeEvent(row.eventJson).pipe(Effect.orDie);

          // Presence names the bot chat a client shows; a group answer is not in it.
          const suppressed =
            !event.groupId &&
            (yield* repository.isSuppressed(
              device.installationId,
              event.agentId,
            ));

          const transport = transports[device.transport];

          if (
            suppressed ||
            !transport ||
            (transport.canSend && !transport.canSend(device))
          ) {
            yield* repository.markDelivered(
              row.outboxId,
              device.installationId,
            );
            continue;
          }

          yield* send(transport, row, device, event);
        }

        yield* repository.cleanup;
      });

      // Uninterruptible, so closing waits for a send in progress instead of losing its outcome.
      const drain = passes
        .withPermits(1)(pass)
        .pipe(Effect.uninterruptible, Effect.withSpan("Push.drain"));

      // Runs before the repository closes: what is queued gets one last pass.
      yield* Effect.addFinalizer(() => drain);

      const device = Effect.fn("Push.device")(function* (
        installationId: string,
        input: PushDeviceInput,
      ) {
        yield* repository.upsertDevice(installationId, input);
        const transport = transports[input.transport];

        return {
          serverId,
          remoteDelivery:
            input.enabled &&
            !!transport &&
            (!transport.canSend || transport.canSend(input)),
        };
      });

      const enqueue = Effect.fn("Push.enqueue")(function* (
        activity: ReplyActivity,
      ) {
        const createdAt =
          activity.createdAt ?? DateTime.formatIso(yield* DateTime.now);

        yield* repository.enqueue(
          canonicalReplyEvent({ ...activity, createdAt }, serverId),
        );
      });

      return Push.of({
        serverId,
        transports: { apns: !!transports.apns, fcm: !!transports.fcm },
        device,
        remove: repository.deleteDevice,
        presence: repository.setPresence,
        enqueue,
        drain,
      });
    }),
  );

  static layer(dataDir: string) {
    return this.layerNoDeps.pipe(
      Layer.provide(PushRepository.layer(dataDir)),
      Layer.provide(PushTransports.layer),
    );
  }
}

/**
 * Delivers the owner's replies as they finish and polls for retries that come due; when each retry is due stays
 * in the outbox. Closing stops both before `Push` makes its last pass.
 */
export const PushDelivery = Layer.effectDiscard(
  Effect.gen(function* () {
    const push = yield* Push;
    const activity = yield* BotActivity;
    const replies = yield* Queue.unbounded<ReplyActivity>();

    const backgroundDrain = push.drain.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Push delivery pass failed", cause),
      ),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        activity.subscribe((event) => {
          if (event.type === "reply" && event.origin !== "bot")
            Queue.offerUnsafe(replies, event);
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    yield* Queue.take(replies).pipe(
      Effect.flatMap(push.enqueue),
      Effect.andThen(backgroundDrain),
      Effect.forever,
      Effect.forkScoped,
    );

    yield* backgroundDrain.pipe(
      Effect.delay("1 second"),
      Effect.repeat(Schedule.fixed("1 second")),
      Effect.forkScoped,
    );
  }),
);

/** Runs push effects from code outside Effect, such as HTTP handlers. */
export type PushRuntime = Runner<Push>;

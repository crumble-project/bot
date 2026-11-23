import type { Redacted } from "effect";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Predicate,
  RcMap,
  Result,
  Schema,
  Scope,
} from "effect";
import { PasswordManagers } from "../password-managers/password-manager";
import type { ConnectedClient } from "../password-managers/password-manager";
import type { PasswordManagerId } from "../contract/secrets";
import { PasswordManagerRepository } from "../password-managers/password-manager-repository";

export type SecretSource =
  | { readonly stored: Redacted.Redacted }
  | {
      readonly passwordManager: PasswordManagerId;
      readonly reference: string;
    };

const keyOf = (id: PasswordManagerId, reference: string) =>
  `${id}\u0000${reference}`;

const readThrough = (client: ConnectedClient, reference: string) =>
  client.read([reference]).pipe(
    Effect.mapError(readFailure),
    Effect.flatMap((reads) => {
      const read = reads.get(reference);

      if (read && Result.isSuccess(read)) {
        return Effect.succeed(read.success);
      }

      return Effect.fail<ReadFailure>({
        reason: read?.failure.message ?? "didn't answer for this reference",
        retainCache: false,
        kind: read?.failure.kind,
      });
    }),
  );

export const FRESH_FOR = Duration.hours(1);

export const REFRESH_AFTER = Duration.minutes(55);

export const STALE_UNTIL = Duration.hours(2);

const CLIENT_IDLE = Duration.hours(1);

export class SecretUnavailable extends Schema.TaggedError<SecretUnavailable>()(
  "SecretUnavailable",
  {
    passwordManager: Schema.String,
    message: Schema.String,
    kind: Schema.optional(Schema.Literal("missing-field")),
  },
) {}

type CachedValue = {
  value: Redacted.Redacted;
  readAt: number;
  refreshing: boolean;
};

type ReadFailure = {
  reason: string;
  retainCache: boolean;
  kind?: "missing-field" | undefined;
};

const readFailure = (error: { readonly message: string }): ReadFailure => ({
  reason: error.message,
  retainCache: Predicate.isTagged(error, "PasswordManagerUnreachable"),
});

export class SecretValues extends Context.Service<
  SecretValues,
  {
    readonly read: (
      source: SecretSource,
    ) => Effect.Effect<Redacted.Redacted, SecretUnavailable>;

    readonly readNow: (source: {
      readonly passwordManager: PasswordManagerId;
      readonly reference: string;
    }) => Effect.Effect<Redacted.Redacted, SecretUnavailable>;
    readonly forget: (
      passwordManager: PasswordManagerId,
      reference: string,
    ) => Effect.Effect<void>;

    readonly disconnect: (
      passwordManager: PasswordManagerId,
    ) => Effect.Effect<void>;
  }
>()("crumble/secrets/SecretValues") {
  static readonly layer = Layer.effect(
    SecretValues,
    Effect.gen(function* () {
      const managers = yield* PasswordManagers;
      const repository = yield* PasswordManagerRepository;
      const layerScope = yield* Scope.Scope;

      const cache = new Map<string, CachedValue>();

      const connections = new Map<PasswordManagerId, Scope.Closeable>();

      let epoch = 0;

      const clients = yield* RcMap.make({
        lookup: (id: PasswordManagerId) =>
          Effect.gen(function* () {
            const token = yield* repository.token(id);

            if (!token) {
              return yield* Effect.fail<ReadFailure>({
                reason: "isn't connected",
                retainCache: false,
              });
            }

            const connection = yield* Scope.make();
            connections.set(id, connection);

            yield* Effect.addFinalizer(() =>
              Effect.suspend(() => {
                if (connections.get(id) === connection) {
                  connections.delete(id);
                }

                return Scope.close(connection, Exit.void);
              }),
            );

            return yield* managers
              .connect(id, token)
              .pipe(Scope.provide(connection), Effect.mapError(readFailure));
          }),
        idleTimeToLive: CLIENT_IDLE,
      });

      const fetch = (id: PasswordManagerId, reference: string) =>
        Effect.scoped(
          RcMap.get(clients, id).pipe(
            Effect.tapError(() => RcMap.invalidate(clients, id)),
            Effect.flatMap((client) => readThrough(client, reference)),
          ),
        );

      const fetchAndStore = (id: PasswordManagerId, reference: string) =>
        Effect.gen(function* () {
          const key = keyOf(id, reference);
          const started = epoch;

          return yield* fetch(id, reference).pipe(
            Effect.tap((value) =>
              Clock.currentTimeMillis.pipe(
                Effect.tap((readAt) =>
                  Effect.sync(() => {
                    if (
                      epoch === started &&
                      !managers.isVolatile(id, reference)
                    ) {
                      cache.set(key, { value, readAt, refreshing: false });
                    }
                  }),
                ),
              ),
            ),
            Effect.tapError((failure) =>
              Effect.sync(() => {
                const cached = cache.get(key);

                if (!failure.retainCache) {
                  cache.delete(key);
                } else if (cached) {
                  cached.refreshing = false;
                }
              }),
            ),
          );
        });

      const unavailable = (id: PasswordManagerId, failure: ReadFailure) => {
        const passwordManager = managers.name(id);

        return new SecretUnavailable({
          passwordManager,
          message: `${passwordManager} ${failure.reason}`,
          kind: failure.kind,
        });
      };

      const readReference = Effect.fnUntraced(function* (
        id: PasswordManagerId,
        reference: string,
      ) {
        const key = keyOf(id, reference);
        const now = yield* Clock.currentTimeMillis;
        const cached = cache.get(key);
        const age = cached ? now - cached.readAt : Number.POSITIVE_INFINITY;

        if (cached && age < Duration.toMillis(FRESH_FOR)) {
          if (age >= Duration.toMillis(REFRESH_AFTER) && !cached.refreshing) {
            cached.refreshing = true;
            yield* Effect.forkIn(
              Effect.ignore(fetchAndStore(id, reference)),
              layerScope,
            );
          }

          return cached.value;
        }

        return yield* fetchAndStore(id, reference).pipe(
          Effect.catch((error) =>
            error.retainCache && cached && age < Duration.toMillis(STALE_UNTIL)
              ? Effect.succeed(cached.value)
              : Effect.fail(unavailable(id, error)),
          ),
        );
      });

      const disconnect = (id: PasswordManagerId) =>
        Effect.gen(function* () {
          epoch++;

          for (const key of cache.keys()) {
            if (key.startsWith(`${id}\u0000`)) {
              cache.delete(key);
            }
          }

          yield* RcMap.invalidate(clients, id);

          const connection = connections.get(id);
          connections.delete(id);

          if (connection) {
            yield* Scope.close(connection, Exit.void);
          }
        });

      return SecretValues.of({
        read: (source) =>
          "stored" in source
            ? Effect.succeed(source.stored)
            : readReference(source.passwordManager, source.reference),
        readNow: ({ passwordManager, reference }) =>
          fetchAndStore(passwordManager, reference).pipe(
            Effect.mapError((failure) => unavailable(passwordManager, failure)),
          ),
        forget: (id, reference) =>
          Effect.sync(() => {
            epoch++;
            cache.delete(keyOf(id, reference));
          }),
        disconnect,
      });
    }),
  );
}

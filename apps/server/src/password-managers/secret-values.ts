import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Predicate,
  RcMap,
  Redacted,
  Result,
  Schema,
  Scope,
} from "effect";
import { PasswordManagers, type ConnectedClient } from "./password-manager";
import type { PasswordManagerId } from "../shared/domain";
import type { SecretBox } from "../shared/secret-box";
import { PasswordManagerRepository } from "./password-manager-repository";

/** Where a secret's value comes from: stored in Crumble, or read from a password manager. */
export type SecretSource =
  | { readonly stored: Redacted.Redacted }
  | {
      readonly passwordManager: PasswordManagerId;
      readonly reference: string;
    };

/** A row with `secretSource` columns. */
type SecretSourceRow = {
  value: string | null;
  passwordManager: PasswordManagerId | null;
  reference: string | null;
};

/** The row's source, decrypting a stored value; the database allows exactly one of the two. */
export const secretSourceOf = (
  box: SecretBox["Service"],
  row: SecretSourceRow,
): SecretSource => {
  if (row.value !== null)
    return { stored: Redacted.make(box.decrypt(row.value)) };

  if (row.passwordManager === null || row.reference === null)
    throw new Error("A secret has neither a stored value nor a reference");

  return { passwordManager: row.passwordManager, reference: row.reference };
};

/** A read value is used without asking the password manager again for this long. */
export const FRESH_FOR = Duration.hours(1);

/** A use after this refreshes the value in the background, so requests rarely wait for a read. */
export const REFRESH_AFTER = Duration.minutes(55);

/** While the password manager is unreachable, a value read this long ago is still used. */
export const STALE_UNTIL = Duration.hours(2);

/** A signed-in client nobody reads through is released after this long. */
const CLIENT_IDLE = Duration.hours(1);

/** A secret's value can't be read from its password manager, and no usable cached value is left. */
export class SecretUnavailable extends Schema.TaggedError<SecretUnavailable>()(
  "SecretUnavailable",
  {
    /** The password manager's name, such as 1Password. */
    passwordManager: Schema.String,
    /** What follows the name, such as "has no item that matches". */
    reason: Schema.String,
    message: Schema.String,
  },
) {}

type CachedValue = {
  value: Redacted.Redacted;
  readAt: number;
  refreshing: boolean;
};

/** Why a read failed, and whether a cached value may still stand in for it. */
type ReadFailure = { reason: string; retainCache: boolean };

// Only an unreachable password manager leaves a cached value usable; anything else means it may be revoked.
const readFailure = (error: { readonly message: string }): ReadFailure => ({
  reason: error.message,
  retainCache: Predicate.isTagged(error, "PasswordManagerUnreachable"),
});

/**
 * The value behind every secret: stored ones as they are, password manager ones read through one signed-in client per
 * password manager and cached in memory only. See `FRESH_FOR`, `REFRESH_AFTER`, and `STALE_UNTIL`.
 */
export class SecretValues extends Context.Service<
  SecretValues,
  {
    readonly read: (
      source: SecretSource,
    ) => Effect.Effect<Redacted.Redacted, SecretUnavailable>;
    /** Asks the password manager now, ignoring any cached value, and caches what it answers; use to check a reference. */
    readonly readNow: (source: {
      readonly passwordManager: PasswordManagerId;
      readonly reference: string;
    }) => Effect.Effect<Redacted.Redacted, SecretUnavailable>;
    /** Drops a reference's cached value, such as when its secret is edited or deleted. */
    readonly forget: (
      passwordManager: PasswordManagerId,
      reference: string,
    ) => Effect.Effect<void>;
    /** Closes the password manager's client, interrupting its reads, and drops its cached values; use on a new token or disconnect. */
    readonly disconnect: (
      passwordManager: PasswordManagerId,
    ) => Effect.Effect<void>;
  }
>()("crumble/password-managers/SecretValues") {
  static readonly layer = Layer.effect(
    SecretValues,
    Effect.gen(function* () {
      const managers = yield* PasswordManagers;
      const repository = yield* PasswordManagerRepository;
      const layerScope = yield* Scope.Scope;

      const cache = new Map<string, CachedValue>();
      // Each client's own scope: closing it interrupts reads that still hold the client, which RcMap.invalidate doesn't.
      const connections = new Map<PasswordManagerId, Scope.Closeable>();
      // Bumped by forget and disconnect, so a read that started before them doesn't cache its value.
      let epoch = 0;

      const clients = yield* RcMap.make({
        lookup: (id: PasswordManagerId) =>
          Effect.gen(function* () {
            const token = yield* repository.token(id);

            if (!token)
              return yield* Effect.fail<ReadFailure>({
                reason: "isn't connected",
                retainCache: false,
              });

            const connection = yield* Scope.make();
            connections.set(id, connection);

            yield* Effect.addFinalizer(() =>
              Effect.suspend(() => {
                if (connections.get(id) === connection) connections.delete(id);

                return Scope.close(connection, Exit.void);
              }),
            );

            return yield* managers
              .connect(id, token)
              .pipe(Scope.provide(connection), Effect.mapError(readFailure));
          }),
        idleTimeToLive: CLIENT_IDLE,
      });

      const keyOf = (id: PasswordManagerId, reference: string) =>
        `${id}\u0000${reference}`;

      const readThrough = (client: ConnectedClient, reference: string) =>
        client.read([reference]).pipe(
          Effect.mapError(readFailure),
          Effect.flatMap((reads) => {
            const read = reads.get(reference);

            if (read && Result.isSuccess(read))
              return Effect.succeed(read.success);

            return Effect.fail<ReadFailure>({
              reason:
                read?.failure.message ?? "didn't answer for this reference",
              retainCache: false,
            });
          }),
        );

      // A failed sign-in stays in the RcMap until it is invalidated, so the next read signs in again.
      const fetch = (id: PasswordManagerId, reference: string) =>
        Effect.scoped(
          RcMap.get(clients, id).pipe(
            Effect.tapError(() => RcMap.invalidate(clients, id)),
            Effect.flatMap((client) => readThrough(client, reference)),
          ),
        );

      /** Reads the value and caches it; a failure that means the value is gone drops the cached one. */
      const fetchAndStore = (id: PasswordManagerId, reference: string) =>
        Effect.gen(function* () {
          const key = keyOf(id, reference);
          const started = epoch;

          return yield* fetch(id, reference).pipe(
            Effect.tap((value) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((readAt) => {
                  if (epoch === started)
                    cache.set(key, { value, readAt, refreshing: false });
                }),
              ),
            ),
            Effect.tapError((failure) =>
              Effect.sync(() => {
                const cached = cache.get(key);

                if (!failure.retainCache) cache.delete(key);
                else if (cached) cached.refreshing = false;
              }),
            ),
          );
        });

      const unavailable = (id: PasswordManagerId, reason: string) => {
        const passwordManager = managers.name(id);

        return new SecretUnavailable({
          passwordManager,
          reason,
          message: `${passwordManager} ${reason}`,
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
          Effect.catch((failure) =>
            failure.retainCache &&
            cached &&
            age < Duration.toMillis(STALE_UNTIL)
              ? Effect.succeed(cached.value)
              : Effect.fail(unavailable(id, failure.reason)),
          ),
        );
      });

      const disconnect = (id: PasswordManagerId) =>
        Effect.gen(function* () {
          epoch++;

          for (const key of cache.keys())
            if (key.startsWith(`${id}\u0000`)) cache.delete(key);

          yield* RcMap.invalidate(clients, id);

          const connection = connections.get(id);
          connections.delete(id);

          if (connection) yield* Scope.close(connection, Exit.void);
        });

      return SecretValues.of({
        read: (source) =>
          "stored" in source
            ? Effect.succeed(source.stored)
            : readReference(source.passwordManager, source.reference),
        readNow: ({ passwordManager, reference }) =>
          fetchAndStore(passwordManager, reference).pipe(
            Effect.mapError((failure) =>
              unavailable(passwordManager, failure.reason),
            ),
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

import { Context, Effect, Layer, Redacted } from "effect";
import { SecretRepository } from "../credentials/secret-repository";
import type { SecretInput, SecretStatus } from "../shared/domain";
import { InvalidInput } from "../shared/errors";
import {
  PasswordManagers,
  type PasswordManagerVendor,
} from "./password-manager";
import {
  SecretValues,
  type SecretSource,
  type SecretUnavailable,
} from "./secret-values";

/** A secret's key in the store, such as `github-account:<id>`; parts are escaped so a prefix never matches by accident. */
export const secretKey = (kind: string, ...ids: readonly string[]) =>
  [kind, ...ids.map(encodeURIComponent)].join(":");

/** The prefix of every key `secretKey(kind, ...ids, ...)` builds, for deleting a bot's or a login's secrets at once. */
export const secretKeyPrefix = (kind: string, ...ids: readonly string[]) =>
  `${secretKey(kind, ...ids)}:`;

const NO_SECRET: SecretStatus = {
  configured: false,
  passwordManager: null,
  reference: null,
};

const statusOf = (source: SecretSource | undefined): SecretStatus =>
  !source
    ? NO_SECRET
    : "stored" in source
      ? { ...NO_SECRET, configured: true }
      : {
          configured: true,
          passwordManager: source.passwordManager,
          reference: source.reference,
        };

/**
 * Every secret the owner enters, by key: stored encrypted in Crumble or read from a password manager. Saving checks
 * a reference by reading it; reading caches it (see `SecretValues`); replacing or deleting one drops its cached value.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    /**
     * Gets the value, reading a reference now and refusing one that can't be read, hands it to `verify`, and stores
     * the secret only if `verify` succeeds. Returns what `verify` returns.
     */
    readonly save: <A = void, E = never, R = never>(
      key: string,
      input: SecretInput,
      verify?: (value: Redacted.Redacted) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | InvalidInput, R>;
    /** Saves several secrets, such as a login's fields, storing none unless every one reads and passes `verify`. */
    readonly saveAll: <E = never, R = never>(
      entries: ReadonlyArray<{
        key: string;
        input: SecretInput;
        verify?: (value: Redacted.Redacted) => Effect.Effect<void, E, R>;
      }>,
    ) => Effect.Effect<void, E | InvalidInput, R>;
    /**
     * The value when it is used; undefined when the key has no secret. `fresh` asks the password manager even when a
     * cached value is fresh, for values that change by the second, such as a computed one-time code.
     */
    readonly read: (
      key: string,
      options?: { fresh?: boolean },
    ) => Effect.Effect<Redacted.Redacted | undefined, SecretUnavailable>;
    readonly status: (key: string) => Effect.Effect<SecretStatus>;
    /** Returns whether there was a secret to delete. */
    readonly delete: (key: string) => Effect.Effect<boolean>;
    /** Deletes every secret under a `secretKeyPrefix`, such as a deleted bot's. */
    readonly deleteAll: (prefix: string) => Effect.Effect<void>;
  }
>()("crumble/password-managers/Secrets") {
  static readonly layer = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const repository = yield* SecretRepository;
      const managers = yield* PasswordManagers;
      const values = yield* SecretValues;

      const forget = (source: SecretSource | undefined) =>
        source && "reference" in source
          ? values.forget(source.passwordManager, source.reference)
          : Effect.void;

      const valueOf = Effect.fnUntraced(function* (input: SecretInput) {
        if (!input.reference) return Redacted.make(input.value ?? "");

        yield* managers.checkReference(
          input.reference.passwordManager,
          input.reference.reference,
        );

        return yield* values
          .readNow(input.reference)
          .pipe(
            Effect.mapError(
              (error) => new InvalidInput({ message: error.message }),
            ),
          );
      });

      const store = Effect.fnUntraced(function* (
        key: string,
        input: SecretInput,
        value: Redacted.Redacted,
      ) {
        const before = yield* repository.source(key);

        if (input.reference)
          yield* repository.setReference(key, input.reference);
        else yield* repository.set(key, Redacted.value(value));

        const same =
          before &&
          "reference" in before &&
          before.passwordManager === input.reference?.passwordManager &&
          before.reference === input.reference.reference;

        if (!same) yield* forget(before);
      });

      const save = Effect.fnUntraced(function* <A, E, R>(
        key: string,
        input: SecretInput,
        verify?: (value: Redacted.Redacted) => Effect.Effect<A, E, R>,
      ) {
        const value = yield* valueOf(input);
        // SAFETY: A defaults to void when `verify` is omitted, so undefined is what the caller gets.
        const verified = verify ? yield* verify(value) : (undefined as A);

        yield* store(key, input, value);

        return verified;
      });

      const saveAll = Effect.fnUntraced(function* <E, R>(
        entries: ReadonlyArray<{
          key: string;
          input: SecretInput;
          verify?: (value: Redacted.Redacted) => Effect.Effect<void, E, R>;
        }>,
      ) {
        const checked = yield* Effect.forEach(entries, (entry) =>
          valueOf(entry.input).pipe(
            Effect.tap((value) => entry.verify?.(value) ?? Effect.void),
          ),
        );

        for (const [index, entry] of entries.entries())
          yield* store(entry.key, entry.input, checked[index]!);
      });

      const read = Effect.fn("Secrets.read")(function* (
        key: string,
        options?: { fresh?: boolean },
      ) {
        const source = yield* repository.source(key);

        if (!source) return undefined;

        return options?.fresh && "reference" in source
          ? yield* values.readNow(source)
          : yield* values.read(source);
      });

      const remove = Effect.fn("Secrets.delete")(function* (key: string) {
        const before = yield* repository.source(key);

        yield* repository.delete(key);
        yield* forget(before);

        return before !== undefined;
      });

      const deleteAll = Effect.fn("Secrets.deleteAll")(function* (
        prefix: string,
      ) {
        for (const source of yield* repository.deleteAll(prefix))
          yield* forget(source);
      });

      return Secrets.of({
        save,
        saveAll,
        read,
        status: (key) => Effect.map(repository.source(key), statusOf),
        delete: remove,
        deleteAll,
      });
    }),
  );
}

/** Reads a secret as text, for plugins and adapters that take a plain string; undefined when there is none. */
export const secretText = (secrets: Secrets["Service"]) => (key: string) =>
  secrets.read(key).pipe(Effect.map((value) => value && Redacted.value(value)));

/** `Secrets` with what it reads through: `SecretValues` and the password managers `vendors` offer. */
export const secretsLayer = (vendors: ReadonlyArray<PasswordManagerVendor>) =>
  Secrets.layer.pipe(
    Layer.provideMerge(SecretValues.layer),
    Layer.provideMerge(PasswordManagers.layer(vendors)),
  );

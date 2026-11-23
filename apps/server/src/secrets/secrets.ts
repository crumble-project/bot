import { Context, Effect, Layer, Redacted } from "effect";
import { PendingStates, ServerSecrets } from "./server-secrets";
import { SecretRepository } from "./secret-repository";
import type {
  PasswordManagerId,
  SecretInput,
  SecretReference,
  SecretStatus,
} from "../contract/secrets";
import { InvalidInput } from "../shared/errors";
import { PasswordManagers } from "../password-managers/password-manager";
import type { PasswordManagerVendor } from "../password-managers/password-manager";
import { SecretValues } from "./secret-values";
import type { SecretSource, SecretUnavailable } from "./secret-values";

export class Secrets extends Context.Service<
  Secrets,
  {
    readonly save: {
      (key: string, input: SecretInput): Effect.Effect<void, InvalidInput>;
      <A, E = never, R = never>(
        key: string,
        input: SecretInput,
        verify: (value: Redacted.Redacted) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | InvalidInput, R>;
    };

    readonly saveAll: <E = never, R = never>(
      entries: ReadonlyArray<{
        key: string;
        input: SecretInput;
        verify?: (value: Redacted.Redacted) => Effect.Effect<void, E, R>;
      }>,
    ) => Effect.Effect<void, E | InvalidInput, R>;
    readonly read: (
      key: string,
    ) => Effect.Effect<Redacted.Redacted | undefined, SecretUnavailable>;

    readonly probe: (
      source: SecretReference,
    ) => Effect.Effect<boolean, InvalidInput>;
    readonly isVolatile: (source: {
      passwordManager: PasswordManagerId | null;
      reference: string | null;
    }) => boolean;
    readonly status: (key: string) => Effect.Effect<SecretStatus>;
    readonly delete: (key: string) => Effect.Effect<boolean>;
    readonly deleteAll: (prefix: string) => Effect.Effect<void>;
  }
>()("crumble/secrets/Secrets") {
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
        if (!input.reference) {
          return Redacted.make(input.value ?? "");
        }

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

        if (input.reference) {
          yield* repository.setReference(key, input.reference);
        } else {
          yield* repository.set(key, Redacted.value(value));
        }

        const same =
          before &&
          "reference" in before &&
          before.passwordManager === input.reference?.passwordManager &&
          before.reference === input.reference.reference;

        if (!same) {
          yield* forget(before);
        }
      });

      const saveVerified = Effect.fnUntraced(function* <A, E, R>(
        key: string,
        input: SecretInput,
        verify: (value: Redacted.Redacted) => Effect.Effect<A, E, R>,
      ) {
        const value = yield* valueOf(input);
        const verified = yield* verify(value);

        yield* store(key, input, value);

        return verified;
      });

      const saveUnverified = Effect.fnUntraced(function* (
        key: string,
        input: SecretInput,
      ) {
        yield* store(key, input, yield* valueOf(input));
      });

      function save(
        key: string,
        input: SecretInput,
      ): Effect.Effect<void, InvalidInput>;
      function save<A, E = never, R = never>(
        key: string,
        input: SecretInput,
        verify: (value: Redacted.Redacted) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | InvalidInput, R>;
      function save<A, E, R>(
        key: string,
        input: SecretInput,
        verify?: (value: Redacted.Redacted) => Effect.Effect<A, E, R>,
      ) {
        return verify === undefined
          ? saveUnverified(key, input)
          : saveVerified(key, input, verify);
      }

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

        for (const [index, entry] of entries.entries()) {
          const value = checked[index];

          if (value !== undefined) {
            yield* store(entry.key, entry.input, value);
          }
        }
      });

      const read = Effect.fn("Secrets.read")(function* (key: string) {
        const source = yield* repository.source(key);

        return source && (yield* values.read(source));
      });

      const probe = Effect.fn("Secrets.probe")(function* (
        source: SecretReference,
      ) {
        yield* managers.checkReference(
          source.passwordManager,
          source.reference,
        );

        return yield* values.readNow(source).pipe(
          Effect.as(true),
          Effect.catchTag("SecretUnavailable", (error) =>
            error.kind === "missing-field"
              ? Effect.succeed(false)
              : Effect.fail(new InvalidInput({ message: error.message })),
          ),
        );
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
        for (const source of yield* repository.deleteAll(prefix)) {
          yield* forget(source);
        }
      });

      return Secrets.of({
        save,
        saveAll,
        read,
        probe,
        isVolatile: ({ passwordManager, reference }) =>
          passwordManager !== null &&
          reference !== null &&
          managers.isVolatile(passwordManager, reference),
        status: repository.status,
        delete: remove,
        deleteAll,
      });
    }),
  );
}

export const secretText = (secrets: Secrets["Service"]) => (key: string) =>
  secrets.read(key).pipe(Effect.map((value) => value && Redacted.value(value)));

export const secretsLayer = (vendors: ReadonlyArray<PasswordManagerVendor>) =>
  Layer.mergeAll(Secrets.layer, ServerSecrets.layer, PendingStates.layer).pipe(
    Layer.provideMerge(SecretValues.layer),
    Layer.provideMerge(PasswordManagers.layer(vendors)),
  );

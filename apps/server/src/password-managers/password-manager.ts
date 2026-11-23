import type { Redacted, Result } from "effect";
import { Context, Deferred, Effect, Layer, Option, Schema } from "effect";
import type { Scope } from "effect";
import type { LoginField, PasswordManagerId } from "../contract/secrets";
import { InvalidInput } from "../shared/errors";

export const PASSWORD_MANAGER_TIMEOUT = "10 seconds";

export class PasswordManagerTokenRejected extends Schema.TaggedError<PasswordManagerTokenRejected>()(
  "PasswordManagerTokenRejected",
  { message: Schema.String },
) {}

export class PasswordManagerUnreachable extends Schema.TaggedError<PasswordManagerUnreachable>()(
  "PasswordManagerUnreachable",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class PasswordManagerUnsupported extends Schema.TaggedError<PasswordManagerUnsupported>()(
  "PasswordManagerUnsupported",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class SecretUnreadable extends Schema.TaggedError<SecretUnreadable>()(
  "SecretUnreadable",
  {
    reference: Schema.String,
    message: Schema.String,
    kind: Schema.optional(Schema.Literal("missing-field")),
  },
) {}

export class PasswordManagerDisconnected extends Schema.TaggedError<PasswordManagerDisconnected>()(
  "PasswordManagerDisconnected",
  { message: Schema.String },
) {}

export type PasswordManagerError =
  | PasswordManagerTokenRejected
  | PasswordManagerUnreachable
  | PasswordManagerUnsupported;

export type SecretRead = Result.Result<Redacted.Redacted, SecretUnreadable>;

export interface PasswordManagerClient<
  E = PasswordManagerTokenRejected | PasswordManagerUnreachable,
> {
  read(
    references: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, SecretRead>, E>;
}

export type ConnectedClient = PasswordManagerClient<
  | PasswordManagerTokenRejected
  | PasswordManagerUnreachable
  | PasswordManagerDisconnected
>;

export interface PasswordManagerVendor {
  readonly id: PasswordManagerId;
  readonly name: string;
  readonly reference: Schema.Decoder<string>;
  readonly itemFields?: (item: string) => Record<LoginField, string>;

  readonly isVolatile?: (reference: string) => boolean;

  signIn(
    token: Redacted.Redacted,
  ): Effect.Effect<PasswordManagerClient, PasswordManagerError>;
}

const timed = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: PASSWORD_MANAGER_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new PasswordManagerUnreachable({
            message: `did not answer within ${PASSWORD_MANAGER_TIMEOUT}`,
            cause: undefined,
          }),
        ),
    }),
  );

const connected = (
  vendor: PasswordManagerVendor,
  token: Redacted.Redacted,
): Effect.Effect<ConnectedClient, PasswordManagerError, Scope.Scope> =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<never, PasswordManagerDisconnected>();

    const held = yield* Effect.acquireRelease(
      timed(vendor.signIn(token)).pipe(
        Effect.map((client) => ({ client: Option.some(client) })),
      ),
      (held) =>
        Deferred.fail(
          closed,
          new PasswordManagerDisconnected({
            message: "was disconnected",
          }),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              held.client = Option.none();
            }),
          ),
        ),
    );

    return {
      read: (references) =>
        Effect.suspend(() =>
          Option.match(held.client, {
            onNone: () => Deferred.await(closed),
            onSome: (client) =>
              timed(client.read(references)).pipe(
                Effect.raceFirst(Deferred.await(closed)),
              ),
          }),
        ),
    };
  });

export class PasswordManagers extends Context.Service<
  PasswordManagers,
  {
    readonly ids: ReadonlyArray<PasswordManagerId>;
    readonly name: (id: PasswordManagerId) => string;

    readonly checkReference: (
      id: PasswordManagerId,
      reference: string,
    ) => Effect.Effect<void, InvalidInput>;
    readonly itemFields: (
      id: PasswordManagerId,
      item: string,
    ) => Record<LoginField, string>;
    readonly isVolatile: (id: PasswordManagerId, reference: string) => boolean;
    readonly connect: (
      id: PasswordManagerId,
      token: Redacted.Redacted,
    ) => Effect.Effect<ConnectedClient, PasswordManagerError, Scope.Scope>;
  }
>()("crumble/password-managers/PasswordManagers") {
  static layer(vendors: ReadonlyArray<PasswordManagerVendor>) {
    const byId = new Map(vendors.map((vendor) => [vendor.id, vendor]));

    const vendorOf = (id: PasswordManagerId) => {
      const vendor = byId.get(id);

      if (!vendor) {
        throw new Error(`No password manager ${id}`);
      }

      return vendor;
    };

    return Layer.succeed(
      PasswordManagers,
      PasswordManagers.of({
        ids: vendors.map((vendor) => vendor.id),
        name: (id) => vendorOf(id).name,
        checkReference: (id, reference) => {
          const vendor = vendorOf(id);

          return Schema.decodeUnknownEffect(vendor.reference)(reference).pipe(
            Effect.asVoid,
            Effect.mapError(
              () =>
                new InvalidInput({
                  message: `Not a ${vendor.name} reference: ${reference}`,
                }),
            ),
          );
        },
        itemFields: (id, item) => {
          const vendor = vendorOf(id);

          if (!vendor.itemFields) {
            throw new Error(`${vendor.name} has no login items`);
          }

          return vendor.itemFields(item);
        },
        isVolatile: (id, reference) =>
          vendorOf(id).isVolatile?.(reference) === true,
        connect: (id, token) => connected(vendorOf(id), token),
      }),
    );
  }
}

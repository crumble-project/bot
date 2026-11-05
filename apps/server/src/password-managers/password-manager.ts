import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
  type Scope,
} from "effect";
import type { LoginField, PasswordManagerId } from "../shared/domain";
import { InvalidInput } from "../shared/errors";

/** How long a sign-in or read may take; the 1Password SDK otherwise waits minutes when the network is gone. */
export const PASSWORD_MANAGER_TIMEOUT = "10 seconds";

// Error messages follow the password manager's name, as in "1Password could not be reached: ...".

/** The password manager refused the token: it is malformed, expired, or revoked. */
export class PasswordManagerTokenRejected extends Schema.TaggedError<PasswordManagerTokenRejected>()(
  "PasswordManagerTokenRejected",
  { message: Schema.String },
) {}

/** The password manager did not answer in time, or limited the account's requests. A cached value stays usable. */
export class PasswordManagerUnreachable extends Schema.TaggedError<PasswordManagerUnreachable>()(
  "PasswordManagerUnreachable",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The password manager's SDK can't run on this server, such as Bitwarden on Linux arm64. */
export class PasswordManagerUnsupported extends Schema.TaggedError<PasswordManagerUnsupported>()(
  "PasswordManagerUnsupported",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** One reference can't be read: its item or field is gone, or the token may not read it. Its value must not be used. */
export class SecretUnreadable extends Schema.TaggedError<SecretUnreadable>()(
  "SecretUnreadable",
  {
    reference: Schema.String,
    message: Schema.String,
    /** The item exists and lacks the field, which is an answer rather than a failure. */
    kind: Schema.optional(Schema.Literal("missing-field")),
  },
) {}

/** The client's scope closed, such as when the owner disconnected the password manager. */
export class PasswordManagerDisconnected extends Schema.TaggedError<PasswordManagerDisconnected>()(
  "PasswordManagerDisconnected",
  { message: Schema.String },
) {}

export type PasswordManagerError =
  | PasswordManagerTokenRejected
  | PasswordManagerUnreachable
  | PasswordManagerUnsupported;

/** What reading a reference gave: its value, or why this reference alone can't be read. */
export type SecretRead = Result.Result<Redacted.Redacted, SecretUnreadable>;

/** A password manager signed in with one token. It reads values and never writes them. */
export interface PasswordManagerClient<
  E = PasswordManagerTokenRejected | PasswordManagerUnreachable,
> {
  /** Reads every reference, in one request where the password manager allows it. */
  read(
    references: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, SecretRead>, E>;
}

/** A client from `PasswordManagers.connect`: it stops reading when its scope closes. */
export type ConnectedClient = PasswordManagerClient<
  | PasswordManagerTokenRejected
  | PasswordManagerUnreachable
  | PasswordManagerDisconnected
>;

/** A password manager Crumble can read secrets from, such as 1Password. */
export interface PasswordManagerVendor {
  readonly id: PasswordManagerId;
  /** The name owners see, such as in a credential proxy error. */
  readonly name: string;
  /** The references owners paste, such as `op://vault/item/field`. */
  readonly reference: Schema.Decoder<string>;
  /** The references of a login's fields in one of its items, for a vendor that stores logins as items. */
  readonly itemFields?: (item: string) => Record<LoginField, string>;
  /** Whether the value changes by the second, such as a computed one-time code, so it must never be cached. */
  readonly isVolatile?: (reference: string) => boolean;
  /** Signs in with the owner's token, which also checks it. `PasswordManagers.connect` owns the client's lifetime. */
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

/**
 * Signs in and keeps the client until the scope closes. Closing it fails later reads, interrupts running ones, and
 * drops the SDK client; neither SDK can close one, so it is released when garbage-collected.
 */
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
            // Racing the close signal interrupts a read still running when the scope closes.
            onSome: (client) =>
              timed(client.read(references)).pipe(
                Effect.raceFirst(Deferred.await(closed)),
              ),
          }),
        ),
    };
  });

/** The password managers this server supports. Every sign-in and read is bounded by `PASSWORD_MANAGER_TIMEOUT`. */
export class PasswordManagers extends Context.Service<
  PasswordManagers,
  {
    /** The password managers this server supports, in a stable order. */
    readonly ids: ReadonlyArray<PasswordManagerId>;
    readonly name: (id: PasswordManagerId) => string;
    /** Fails with `InvalidInput` unless `reference` has the password manager's reference format. */
    readonly checkReference: (
      id: PasswordManagerId,
      reference: string,
    ) => Effect.Effect<void, InvalidInput>;
    /** The references of a login's fields in one of the password manager's items. */
    readonly itemFields: (
      id: PasswordManagerId,
      item: string,
    ) => Record<LoginField, string>;
    readonly isVolatile: (id: PasswordManagerId, reference: string) => boolean;
    /** A client that reads until the scope closes. */
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

      if (!vendor) throw new Error(`No password manager ${id}`);

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

          if (!vendor.itemFields)
            throw new Error(`${vendor.name} has no login items`);

          return vendor.itemFields(item);
        },
        isVolatile: (id, reference) =>
          vendorOf(id).isVolatile?.(reference) === true,
        connect: (id, token) => connected(vendorOf(id), token),
      }),
    );
  }
}

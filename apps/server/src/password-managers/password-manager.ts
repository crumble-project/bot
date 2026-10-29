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
import { InvalidInput } from "../shared/errors";

/** Settings key of a password manager: never rename. */
export type PasswordManagerId = "1password" | "bitwarden";

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
  { reference: Schema.String, message: Schema.String },
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
        connect: (id, token) => connected(vendorOf(id), token),
      }),
    );
  }
}

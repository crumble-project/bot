import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { SecretUnavailable } from "../secrets/secret-values";
import { Secrets } from "../secrets/secrets";
import type { CredentialTarget } from "../shared/domain";
import {
  AgentCredentialRepository,
  credentialSecretKey,
} from "./agent-credential-repository";
import { credentialLifecycle } from "./credential-lifecycle";

export class CredentialUnminted extends Schema.TaggedError<CredentialUnminted>()(
  "CredentialUnminted",
  { message: Schema.String },
) {}

export class CredentialSource extends Context.Service<
  CredentialSource,
  {
    readonly value: (
      agentId: string,
      target: CredentialTarget,
    ) => Effect.Effect<
      Redacted.Redacted,
      CredentialUnminted | SecretUnavailable
    >;
    readonly env: (agentId: string) => Effect.Effect<Record<string, string>>;
    readonly lines: (agentId: string) => Effect.Effect<string[]>;
    /** Signs a commit or tag as the bot; undefined when the source has no key for it. */
    readonly sign: (
      agentId: string,
      data: Uint8Array,
    ) => Effect.Effect<string | undefined>;
  }
>()("crumble/credentials/CredentialSource") {}

/** Credentials a source mints on use instead of the owner entering them; only the source grants or revokes them. */
export class MintedCredentials extends Context.Service<
  MintedCredentials,
  {
    /** Makes `name` a minted credential; a stored one keeps its placeholder and loses its value. */
    readonly grant: (
      agentId: string,
      name: string,
      hosts: string[],
    ) => Effect.Effect<void>;
    readonly revoke: (agentId: string) => Effect.Effect<void>;
  }
>()("crumble/credentials/MintedCredentials") {
  static readonly layer = Layer.effect(
    MintedCredentials,
    Effect.gen(function* () {
      const repository = yield* AgentCredentialRepository;
      const secrets = yield* Secrets;
      const lifecycle = yield* credentialLifecycle;

      return MintedCredentials.of({
        grant: Effect.fn("MintedCredentials.grant")(
          function* (agentId, name, hosts) {
            yield* repository.save(agentId, name, { hosts, github: true });
            yield* secrets.delete(credentialSecretKey(agentId, name));
          },
        ),
        revoke: Effect.fn("MintedCredentials.revoke")(function* (agentId) {
          const minted = (yield* repository.list(agentId)).filter(
            (credential) => credential.github,
          );

          yield* Effect.forEach(minted, ({ name }) =>
            lifecycle.forget(agentId, name),
          );
        }),
      });
    }),
  );
}

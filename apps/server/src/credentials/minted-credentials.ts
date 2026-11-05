import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { z } from "zod";
import { botSecretLifecycle } from "../bot-secrets/bot-secret-lifecycle";
import type { SecretUnavailable } from "../secrets/secret-values";
import { Secrets } from "../secrets/secrets";
import type { CredentialTarget } from "../shared/domain";
import {
  AgentCredentialRepository,
  credentialSecretKey,
} from "./agent-credential-repository";

/** What a credential's use records beyond its host: the request it was swapped into. */
const useDetail = z.object({
  method: z.string(),
  path: z.string(),
  status: z.number().nullable(),
});

/** The credential kind's lifecycle, shared by the owner's credentials and the minted ones. */
export const credentialLifecycle = Effect.gen(function* () {
  const repository = yield* AgentCredentialRepository;
  const secrets = yield* Secrets;

  return yield* botSecretLifecycle(
    {
      kind: "credential",
      title: "Credential",
      find: repository.get,
      deleteRecord: repository.delete,
      deleteSecrets: (agentId, name) =>
        Effect.asVoid(secrets.delete(credentialSecretKey(agentId, name))),
      touch: repository.touch,
    },
    useDetail,
  );
});

/** A minted credential's value can't be made, such as when its source's service doesn't answer. */
export class CredentialUnminted extends Schema.TaggedError<CredentialUnminted>()(
  "CredentialUnminted",
  { message: Schema.String },
) {}

/** Where the values of minted credentials come from, and what a bot's jobs get from it besides them. */
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
    /** Variables every command of the bot's coding jobs sees. */
    readonly env: (agentId: string) => Effect.Effect<Record<string, string>>;
    /** What the bot and its jobs read about the source. */
    readonly lines: (agentId: string) => Effect.Effect<string[]>;
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
    /** Deletes the bot's minted credentials and their uses. */
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

import { Effect } from "effect";
import { z } from "zod";
import { botSecretLifecycle } from "../bot-secrets/bot-secret-lifecycle";
import { Secrets } from "../secrets/secrets";
import { credentialName } from "../contract/secrets";
import {
  AgentCredentialRepository,
  credentialSecretKey,
} from "./agent-credential-repository";

const useDetail = z.object({
  method: z.string(),
  path: z.string(),
  status: z.number().nullable(),
});

export const credentialLifecycle = Effect.gen(function* () {
  const repository = yield* AgentCredentialRepository;
  const secrets = yield* Secrets;

  return yield* botSecretLifecycle(
    {
      kind: "credential",
      title: "Credential",
      names: credentialName,
      find: repository.get,
      deleteRecord: repository.delete,
      deleteSecrets: (agentId, name) =>
        Effect.asVoid(secrets.delete(credentialSecretKey(agentId, name))),
      touch: repository.touch,
    },
    useDetail,
  );
});

import { Effect } from "effect";
import type { Runner } from "../shared/runner";
import { GUEST_CA_PATH } from "../../workspace-image/guest";
import type { WorkspaceInterceptor } from "../workspaces/workspace-proxy";
import {
  commitSigning,
  GUEST_SIGN_PATH,
  signingHelper,
} from "./commit-signing";
import {
  credentialAuthoritiesAccess,
  type CredentialAuthorities,
} from "./credential-authority";
import { credentialProxy } from "./credential-proxy";
import { credentialsAccess, type Credentials } from "./credentials";
import { CredentialSource } from "./minted-credentials";

const either = (
  first: WorkspaceInterceptor,
  second: WorkspaceInterceptor,
): WorkspaceInterceptor => ({
  wants: (host) => first.wants(host) || second.wants(host),
  answers: (host) =>
    first.answers?.(host) === true || second.answers?.(host) === true,
  handle: (client, host, port) =>
    (first.wants(host) ? first : second).handle(client, host, port),
});

export const credentialInterception = (
  run: Runner<Credentials | CredentialAuthorities | CredentialSource>,
) => {
  const credentials = credentialsAccess(run);
  const authorities = credentialAuthoritiesAccess(run);
  const source = run.runSync(CredentialSource.use(Effect.succeed));

  return {
    guest: async (agentId: string) => ({
      files: [
        { path: GUEST_SIGN_PATH, content: signingHelper(), mode: 0o755 },
        {
          path: GUEST_CA_PATH,
          content: await authorities.certificate(agentId),
        },
      ],
      commands: [
        {
          step: "Installing the credential authority",
          command: "update-ca-certificates >/dev/null",
        },
      ],
    }),
    intercept: (agentId: string) =>
      either(
        commitSigning({
          agentId,
          authorities,
          sign: (data) => run.runPromise(source.sign(agentId, data)),
        }),
        credentialProxy({
          agentId,
          authorities,
          grants: () => credentials.grants(agentId),
          value: (name, target) => credentials.value(agentId, name, target),
          recordUse: (name, use) => credentials.recordUse(agentId, name, use),
        }),
      ),
  };
};

import { GitHubAccounts } from "../github-apps/github-accounts";
import type { Runner } from "../shared/runner";
import {
  GUEST_CA_PATH,
  GUEST_SIGN_PATH,
  signingHelper,
} from "../workspaces/workspace";
import {
  credentialAuthoritiesAccess,
  type CredentialAuthorities,
} from "./credential-authority";
import { credentialProxy } from "./credential-proxy";
import { credentialsAccess, type Credentials } from "./credentials";

/** What a bot's workspace needs for its credentials: the guest trusts the bot's authority, and the proxy adds the secrets. */
export const credentialInterception = (
  run: Runner<Credentials | CredentialAuthorities | GitHubAccounts>,
) => {
  const credentials = credentialsAccess(run);
  const authorities = credentialAuthoritiesAccess(run);

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
      credentialProxy({
        agentId,
        authorities,
        grants: () => credentials.grants(agentId),
        value: (name, target) => credentials.value(agentId, name, target),
        recordUse: (name, use) => credentials.recordUse(agentId, name, use),
        sign: async (data) =>
          (
            await run.runPromise(
              GitHubAccounts.use((accounts) => accounts.ofBot(agentId)),
            )
          )?.sign(data),
      }),
  };
};

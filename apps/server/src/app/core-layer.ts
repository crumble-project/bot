import { Layer } from "effect";
import { ChatAttention } from "../push/chat-attention";
import { PushDatabase } from "../push/push-database";
import { DesktopControl } from "../bot-desktop/desktop-control";
import { HeldActions } from "../bot-desktop/held-actions";
import { BotDeletion } from "../bot-ports/bot-deletion";
import { BotNotices } from "../bot-ports/bot-notices";
import { CallNotes } from "../bot-ports/call-notes";
import { CredentialAuthorities } from "../credentials/credential-authority";
import { Credentials } from "../credentials/credentials";
import { MintedCredentials } from "../credentials/minted-credentials";
import { GitHubAccounts } from "../github-apps/github-accounts";
import { GitHubAppUsers } from "../github-apps/github-app-users";
import { GitHubApps, githubCredentialSource } from "../github-apps/github-apps";
import { Logins } from "../logins/logins";
import { ProviderCredentials } from "../providers/provider-credentials";
import { BotMemory } from "../memory/bot-memory";
import { secretsLayer } from "../secrets/secrets";
import { botSecretCleanup } from "../bot-secrets/bot-secret-lifecycle";
import { BotSecretRequests } from "../bot-secrets/bot-secret-requests";
import { BotSecretUses } from "../bot-secrets/bot-secret-uses";
import { assertVendorIds, pluginPasswordManagers } from "../plugins/plugins";
import { PASSWORD_MANAGER_IDS } from "../shared/vendors";
import { builtinVendors } from "./builtin-plugins";
import { productLayer } from "./product-layer";

const passwordManagers = pluginPasswordManagers(builtinVendors);

assertVendorIds(
  "password manager",
  PASSWORD_MANAGER_IDS,
  passwordManagers.map((vendor) => vendor.id),
);

export const coreLayer = (dataDir: string) =>
  Layer.mergeAll(
    ChatAttention.layer,
    DesktopControl.layer,
    HeldActions.layer,
    Credentials.layer,
    Logins.layer,
    CredentialAuthorities.layer,
    ProviderCredentials.layer,
    BotMemory.layer,
    botSecretCleanup,
  ).pipe(
    Layer.provideMerge(githubCredentialSource),
    Layer.provideMerge(GitHubApps.layer),
    Layer.provideMerge(GitHubAppUsers.layer),
    Layer.provideMerge(GitHubAccounts.layer),
    Layer.provideMerge(MintedCredentials.layer),
    Layer.provideMerge(
      Layer.mergeAll(BotSecretRequests.layer, BotSecretUses.layer),
    ),
    Layer.provideMerge(
      Layer.mergeAll(BotNotices.layer, BotDeletion.layer, CallNotes.layer),
    ),
    Layer.provideMerge(secretsLayer(passwordManagers)),
    Layer.provideMerge(PushDatabase.layer(dataDir)),
    Layer.provideMerge(productLayer(dataDir)),
  );

export type CoreServices = Layer.Success<ReturnType<typeof coreLayer>>;

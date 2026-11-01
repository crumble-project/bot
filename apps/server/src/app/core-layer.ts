import { Layer } from "effect";
import { DesktopControl } from "../bot-desktop/desktop-control";
import { HeldActions } from "../bot-desktop/held-actions";
import { BotNotices } from "../bots/bot-notices";
import { CredentialAuthorities } from "../credentials/credential-authority";
import { Credentials } from "../credentials/credentials";
import { GitHubAppUsers } from "../github-apps/github-app-users";
import { GitHubApps } from "../github-apps/github-apps";
import { Logins } from "../logins/logins";
import { ProviderCredentials } from "../providers/provider-credentials";
import { McpOAuth } from "../integrations/mcp-oauth";
import { BotMemory } from "../memory/bot-memory";
import { PasswordManagers } from "../password-managers/password-manager";
import { SecretValues } from "../password-managers/secret-values";
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

/** The account's repositories and the services that need nothing else: the base every account runtime starts from. */
export const coreLayer = (dataDir: string) =>
  Layer.mergeAll(
    DesktopControl.layer,
    HeldActions.layer,
    Credentials.layer,
    Logins.layer,
    CredentialAuthorities.layer,
    ProviderCredentials.layer,
    McpOAuth.layer,
    BotMemory.layer,
  ).pipe(
    Layer.provideMerge(BotNotices.layer),
    Layer.provideMerge(GitHubApps.layer),
    Layer.provideMerge(GitHubAppUsers.layer),
    Layer.provideMerge(
      SecretValues.layer.pipe(
        Layer.provideMerge(PasswordManagers.layer(passwordManagers)),
      ),
    ),
    Layer.provideMerge(productLayer(dataDir)),
  );

export type CoreServices = Layer.Success<ReturnType<typeof coreLayer>>;

import { Layer } from "effect";
import { DesktopControl } from "../bot-desktop/desktop-control";
import { HeldActions } from "../bot-desktop/held-actions";
import { BotNotices } from "../bots/bot-notices";
import { CredentialAuthorities } from "../credentials/credential-authority";
import { Credentials } from "../credentials/credentials";
import { Logins } from "../logins/logins";
import { ProviderCredentials } from "../providers/provider-credentials";
import { McpOAuth } from "../integrations/mcp-oauth";
import { BotMemory } from "../memory/bot-memory";
import { bitwarden } from "../password-managers/bitwarden";
import { onePassword } from "../password-managers/one-password";
import { PasswordManagers } from "../password-managers/password-manager";
import { SecretValues } from "../password-managers/secret-values";
import { productLayer } from "./product-layer";

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
    Layer.provideMerge(
      SecretValues.layer.pipe(
        Layer.provideMerge(PasswordManagers.layer([onePassword, bitwarden])),
      ),
    ),
    Layer.provideMerge(productLayer(dataDir)),
  );

export type CoreServices = Layer.Success<ReturnType<typeof coreLayer>>;

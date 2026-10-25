import { Layer } from "effect";
import { DesktopControl } from "../bot-desktop/desktop-control";
import { BotNotices } from "../bots/bot-notices";
import { CredentialAuthorities } from "../credentials/credential-authority";
import { Credentials } from "../credentials/credentials";
import { ProviderCredentials } from "../providers/provider-credentials";
import { McpOAuth } from "../integrations/mcp-oauth";
import { BotMemory } from "../memory/bot-memory";
import { productLayer } from "./product-layer";

/** The account's repositories and the services that need nothing else: the base every account runtime starts from. */
export const coreLayer = (dataDir: string) =>
  Layer.mergeAll(
    DesktopControl.layer,
    Credentials.layer,
    CredentialAuthorities.layer,
    ProviderCredentials.layer,
    McpOAuth.layer,
    BotMemory.layer,
  ).pipe(
    Layer.provideMerge(BotNotices.layer),
    Layer.provideMerge(productLayer(dataDir)),
  );

export type CoreServices = Layer.Success<ReturnType<typeof coreLayer>>;

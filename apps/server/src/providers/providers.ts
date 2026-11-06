import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import { ProviderCredentials } from "./provider-credentials";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProviderContribution } from "../plugins/plugins";

type CatalogOptions = NonNullable<Parameters<typeof builtinModels>[0]>;

const catalog = (
  credentials: CredentialStore | undefined,
  contributions: readonly ProviderContribution[],
  options: CatalogOptions,
) => {
  if (credentials) options.credentials = credentials;

  const models = builtinModels(options);

  for (const { provider } of contributions) models.setProvider(provider);

  return models;
};

/** An account's catalog: only credentials the account saved reach a model, never the host's environment or files. */
export const accountModels = (
  credentials: CredentialStore | undefined,
  contributions: readonly ProviderContribution[],
) =>
  catalog(credentials, contributions, {
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });

export const hostModels = (
  credentials: CredentialStore | undefined,
  contributions: readonly ProviderContribution[],
) => catalog(credentials, contributions, {});

export class ProviderModels extends Context.Service<ProviderModels, Models>()(
  "crumble/providers/ProviderModels",
) {
  static layer(
    make: typeof accountModels,
    contributions: readonly ProviderContribution[],
  ) {
    return Layer.effect(
      ProviderModels,
      Effect.gen(function* () {
        return make(yield* ProviderCredentials, contributions);
      }),
    );
  }
}

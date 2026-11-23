import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import { ProviderCredentials } from "./provider-credentials";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProviderContribution } from "../plugins/plugins";
import type { EmulateProfile } from "./emulate-profile";
import { emulateModels } from "./emulate";

type CatalogOptions = NonNullable<Parameters<typeof builtinModels>[0]>;

const catalog = (
  credentials: CredentialStore | undefined,
  contributions: ReadonlyArray<ProviderContribution>,
  options: CatalogOptions,
) => {
  if (credentials) {
    options.credentials = credentials;
  }

  const models = builtinModels(options);

  for (const { provider } of contributions) {
    models.setProvider(provider);
  }

  return models;
};

export const accountModels = (
  credentials: CredentialStore | undefined,
  contributions: ReadonlyArray<ProviderContribution>,
  emulate?: EmulateProfile,
) =>
  emulate
    ? emulateModels(emulate.baseUrl)
    : catalog(credentials, contributions, {
        authContext: {
          env: async () => {},
          fileExists: async () => false,
        },
      });

export const hostModels = (
  credentials: CredentialStore | undefined,
  contributions: ReadonlyArray<ProviderContribution>,
) => catalog(credentials, contributions, {});

export class ProviderModels extends Context.Service<ProviderModels, Models>()(
  "crumble/providers/ProviderModels",
) {
  static layer(
    make: typeof accountModels,
    contributions: ReadonlyArray<ProviderContribution>,
  ) {
    return Layer.effect(
      ProviderModels,
      Effect.gen(function* () {
        return make(yield* ProviderCredentials, contributions);
      }),
    );
  }
}

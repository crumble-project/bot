import {
  createProvider,
  envApiKeyAuth,
  type CredentialStore,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import { ProviderCredentialRepository } from "./provider-credential-repository";
import { ProviderCredentials } from "./provider-credentials";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { z } from "zod";
import {
  pluginProviders,
  type CrumblePlugin,
  type ProviderContribution,
} from "../app/plugins";

const MELIOUS_URL = "https://api.melious.ai/v1";

const modelCatalog = z.object({
  data: z
    .array(
      z.object({
        id: z.string().optional().catch(undefined),
        name: z.string().optional().catch(undefined),
      }),
    )
    .nullish(),
});

/**
 * Melious exposes an OpenAI-compatible API whose catalog changes per account, so models
 * load from `/models` with the saved key. The list carries no limits or prices; the
 * defaults below are conservative placeholders.
 */
export function meliousProvider() {
  return createProvider<"openai-completions">({
    id: "melious",
    name: "Melious",
    baseUrl: MELIOUS_URL,
    auth: { apiKey: envApiKeyAuth("Melious API key", ["MELIOUS_API_KEY"]) },
    models: [],
    api: openAICompletionsApi(),
    fetchModels: async ({ credential, signal, baseUrl }) => {
      const key = credential?.type === "api_key" ? credential.key : undefined;

      if (!key) return [];

      const response = await fetch(`${baseUrl ?? MELIOUS_URL}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal,
      });

      if (!response.ok)
        throw new Error(`Melious model list failed with ${response.status}`);

      const body = modelCatalog.parse(await response.json());

      return (body.data ?? []).flatMap(
        (entry): Model<"openai-completions">[] =>
          entry.id !== undefined
            ? [
                {
                  id: entry.id,
                  name: entry.name ?? entry.id,
                  api: "openai-completions",
                  provider: "melious",
                  baseUrl: baseUrl ?? MELIOUS_URL,
                  input: ["text"],
                  reasoning: false,
                  contextWindow: 128000,
                  maxTokens: 16384,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ]
            : [],
      );
    },
  });
}

/** Melious as a plugin: an OpenAI-compatible provider whose catalog loads per account. */
export const meliousPlugin = (): CrumblePlugin => ({
  id: "melious",
  providers: [{ provider: meliousProvider() }],
});

/**
 * Pi AI's built-in providers plus the plugin providers. Without a store, Pi AI's in-memory default serves
 * catalog-only callers; without contributions, only the providers that need no server configuration are offered.
 */
export function providerModels(
  credentials?: CredentialStore,
  contributions: readonly ProviderContribution[] = pluginProviders([
    meliousPlugin(),
  ]),
  options: { allowAmbientEnv?: boolean } = {},
) {
  const modelOptions: Parameters<typeof builtinModels>[0] = {};

  if (credentials) modelOptions.credentials = credentials;

  if (options.allowAmbientEnv === false)
    modelOptions.authContext = {
      env: async () => undefined,
      fileExists: async () => false,
    };

  const models = builtinModels(modelOptions);

  for (const { provider } of contributions) models.setProvider(provider);

  return models;
}

/** The account's model catalog: built-in and plugin providers over its credentials. */
export class ProviderModels extends Context.Service<ProviderModels, Models>()(
  "crumble/providers/ProviderModels",
) {
  /** Over `contributions`' providers; API keys saved before typed credentials move to the provider table first. */
  static layer(
    contributions?: readonly ProviderContribution[],
    options: { allowAmbientEnv?: boolean } = {},
  ) {
    return Layer.effect(
      ProviderModels,
      Effect.gen(function* () {
        const repository = yield* ProviderCredentialRepository;

        yield* repository.migrateApiKeys(
          providerModels(undefined, contributions, options)
            .getProviders()
            .map((provider) => provider.id),
        );

        return providerModels(
          yield* ProviderCredentials,
          contributions,
          options,
        );
      }),
    );
  }
}

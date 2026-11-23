import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { Model, Models, Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { EMULATE_MODEL_IDS } from "./emulate-profile";

export function validateEmulateBaseUrl(baseUrl: string): void {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/v1$/.exec(baseUrl);

  if (!match || match[0] !== baseUrl || Number(match[1]) > 65_535) {
    throw new Error(
      "Emulate requires http://127.0.0.1:PORT/v1 with a port from 1 to 65535",
    );
  }
}

export function emulateProvider(
  baseUrl: string,
): Provider<"openai-completions"> {
  validateEmulateBaseUrl(baseUrl);

  return createProvider<"openai-completions">({
    id: "emulate",
    name: "Emulate (local)",
    baseUrl,
    auth: {
      apiKey: {
        name: "Local Emulate",
        check: async () => ({ type: "api_key", source: "emulate-local" }),
        resolve: async () => ({
          auth: { apiKey: "emulate-local" },
          source: "emulate-local",
        }),
      },
    },
    models: EMULATE_MODEL_IDS.map((id): Model<"openai-completions"> => ({
      id,
      name: id,
      api: "openai-completions",
      provider: "emulate",
      baseUrl,
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    api: openAICompletionsApi(),
  });
}

export function emulateModels(baseUrl: string): Models {
  const models = createModels({
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });

  models.setProvider(emulateProvider(baseUrl));

  return models;
}

import {
  createProvider,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { z } from "zod";

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

import { createProvider } from "@earendil-works/pi-ai";
import type {
  ApiKeyCredential,
  Model,
  ModelInputModality,
  ModelThinkingLevel,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { CrumblePlugin } from "../../plugins/plugins";
import { SOMA_API, SOMA_PROVIDER, somaStreams } from "./adapter";
import {
  SOMA_TOKEN_ENV,
  SOMA_URL_ENV,
  fetchSomaInfo,
  fetchSomaUpstreams,
  normalizeSomaUrl,
} from "./client";
import type { SomaModelInfo } from "./client";

const PI_THINKING_LEVELS: ReadonlyArray<ModelThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

function resolveSomaCredentials(
  credential: ApiKeyCredential | undefined,
  env: NodeJS.ProcessEnv,
): { baseUrl: string; token: string; source: string } | undefined {
  const savedUrl = credential?.env?.[SOMA_URL_ENV];
  const savedToken = credential?.key;

  if (savedUrl && savedToken) {
    const normalized = normalizeSomaUrl(savedUrl);

    if (normalized) {
      return { baseUrl: normalized, token: savedToken, source: "Soma" };
    }
  }

  const envUrl = env[SOMA_URL_ENV];
  const envToken = env[SOMA_TOKEN_ENV];

  if (envUrl && envToken) {
    const normalized = normalizeSomaUrl(envUrl);

    if (normalized) {
      return {
        baseUrl: normalized,
        token: envToken,
        source: `${SOMA_URL_ENV} / ${SOMA_TOKEN_ENV}`,
      };
    }
  }

  return undefined;
}

function toThinkingLevelMap(info: SomaModelInfo): ThinkingLevelMap | undefined {
  if (info.reasoning === false) {
    return undefined;
  }

  const supported = (info.thinking ?? []).filter(
    (level): level is ModelThinkingLevel =>
      (PI_THINKING_LEVELS as ReadonlyArray<string>).includes(level),
  );

  if (!supported.length) {
    return undefined;
  }

  return Object.fromEntries(
    supported.map((level) => [level, level] as const),
  ) as ThinkingLevelMap;
}

function toInputModalities(
  input: ReadonlyArray<string> | null | undefined,
): Array<ModelInputModality> {
  const modalities = (input ?? []).filter(
    (value): value is ModelInputModality =>
      value === "text" || value === "image",
  );

  return modalities.length > 0 ? modalities : ["text"];
}

function toPiModel(
  upstream: string,
  baseUrl: string,
  info: SomaModelInfo,
): Model<typeof SOMA_API> {
  const id = `${upstream}/${info.id}`;
  const thinkingLevelMap = toThinkingLevelMap(info);

  return {
    id,
    name: id,
    api: SOMA_API,
    provider: SOMA_PROVIDER,
    baseUrl,
    reasoning: info.reasoning !== false,
    ...(thinkingLevelMap && { thinkingLevelMap }),
    input: toInputModalities(info.input),
    contextWindow:
      info.contextWindow && info.contextWindow > 0
        ? info.contextWindow
        : 128_000,
    maxTokens: info.maxOutput && info.maxOutput > 0 ? info.maxOutput : 16_384,
    cost: {
      input: info.inputPrice ?? 0,
      output: info.outputPrice ?? 0,
      cacheRead: info.cachedPrice ?? 0,
      cacheWrite: 0,
    },
  };
}

export function somaProvider(env: NodeJS.ProcessEnv) {
  const holdsConversation = new Map<string, boolean>();

  return createProvider<typeof SOMA_API>({
    id: SOMA_PROVIDER,
    name: "Soma",
    auth: {
      apiKey: {
        name: "Soma token",
        login: async (interaction) => {
          const url = await interaction.prompt({
            type: "text",
            message: "Soma server URL",
            placeholder: "http://127.0.0.1:7662",
          });
          const normalized = normalizeSomaUrl(url);

          if (!normalized) {
            throw new Error(
              "Enter a valid http(s) server URL without credentials, query, or fragment",
            );
          }

          const key = await interaction.prompt({
            type: "secret",
            message: "Soma token",
          });

          return {
            type: "api_key",
            key,
            env: { [SOMA_URL_ENV]: normalized },
          };
        },
        check: async ({ credential }) => {
          const resolved = resolveSomaCredentials(credential, env);

          return resolved
            ? { type: "api_key", source: resolved.source }
            : undefined;
        },
        resolve: async ({ credential }) => {
          const resolved = resolveSomaCredentials(credential, env);

          if (!resolved) {
            return undefined;
          }

          return {
            auth: {
              apiKey: resolved.token,
              baseUrl: resolved.baseUrl,
            },
            env: { [SOMA_URL_ENV]: resolved.baseUrl },
            source: resolved.source,
          };
        },
      },
    },
    models: [],
    api: somaStreams({
      holdsConversation: (upstream) => holdsConversation.get(upstream) ?? false,
    }),
    fetchModels: async ({ credential, signal }) => {
      const apiCredential =
        credential?.type === "api_key" ? credential : undefined;
      const resolved = resolveSomaCredentials(apiCredential, env);

      if (!resolved) {
        return [];
      }

      const connection = {
        baseUrl: resolved.baseUrl,
        token: resolved.token,
      };
      const upstreams = await fetchSomaUpstreams(connection, signal);
      const results = await Promise.allSettled(
        upstreams.map(async (upstream) => ({
          upstream,
          info: await fetchSomaInfo(connection, upstream, signal),
        })),
      );

      const models: Array<Model<typeof SOMA_API>> = [];

      for (const result of results) {
        if (result.status !== "fulfilled") {
          continue;
        }

        const { upstream, info } = result.value;

        holdsConversation.set(upstream, info.holdsConversation);

        for (const modelInfo of info.models) {
          models.push(toPiModel(upstream, resolved.baseUrl, modelInfo));
        }
      }

      return models;
    },
  });
}

export const somaPlugin = (env: NodeJS.ProcessEnv): CrumblePlugin => ({
  id: SOMA_PROVIDER,
  providers: [{ provider: somaProvider(env), requiresBaseUrl: true }],
});

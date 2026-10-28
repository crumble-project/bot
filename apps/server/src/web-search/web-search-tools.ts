import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Layer } from "effect";
import { Plugins, pluginWebSearchProviders } from "../app/plugins";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import { isPublicAddress } from "../workspaces/public-address";
import {
  WEB_EXTRACT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WebExtractionError,
  WebSearchError,
  type WebPage,
  type WebSearchProvider,
} from "./provider";
import { AgentRepository } from "../bots/agent-repository";
import { SettingsRepository } from "../shared/settings-repository";
import { DEFAULT_PROVIDER } from "./settings";

const refused = "Crumble does not read private or local addresses.";
const date = Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }));

const publicUrl = Effect.fnUntraced(function* (value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;

  if (isIP(hostname)) return isPublicAddress(hostname);

  const addresses = yield* Effect.tryPromise({
    try: () => lookup(hostname, { all: true }),
    catch: () => new Error("DNS lookup failed"),
  }).pipe(Effect.catch(() => Effect.succeed([])));

  return (
    addresses.length > 0 &&
    addresses.every(({ address }) => isPublicAddress(address))
  );
});

const extractPage = Effect.fnUntraced(function* (
  url: string,
  extract: NonNullable<WebSearchProvider["extract"]>,
) {
  if (!(yield* publicUrl(url)))
    return { url, error: refused } satisfies WebPage;

  const page = yield* extract(url).pipe(
    Effect.catch((error) =>
      Effect.succeed({ url, error: error.message } satisfies WebPage),
    ),
  );

  if ("error" in page || page.text.length <= 20000) return page;

  return {
    ...page,
    text: `${page.text.slice(0, 20000)}\n\n[Text truncated at 20,000 characters.]`,
  };
});

const searchTool = (
  search: NonNullable<WebSearchProvider["search"]>,
  bot: string,
) =>
  defineTool({
    name: WEB_SEARCH_TOOL_NAME,
    description:
      "Search the web for current information. Returns titles, links, dates, and short excerpts. Use web_extract to read a result in full. Cite each fact you take from a page right after it with a Markdown link labeled source, such as [source](https://en.wikipedia.org/wiki/Bun_(software)). Give any link you want the owner to open descriptive text instead.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 400 }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, default: 5 }),
      ),
      domains: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
      ),
      after: date,
      before: date,
    }),
    callers: ["model"],
    replay: "safe",
    execute: async (input, _api, context) => {
      const results = await Effect.runPromise(
        search({ ...input, limit: input.limit ?? 5 }, bot),
        { signal: context.abortSignal },
      );

      return {
        output: [
          {
            type: "text" as const,
            text:
              results
                .map((result) =>
                  [result.title, result.url, result.published, result.excerpt]
                    .filter(Boolean)
                    .join("\n"),
                )
                .join("\n\n") || "No results.",
          },
        ],
        details: results,
      };
    },
  });

const extractTool = (extract: NonNullable<WebSearchProvider["extract"]>) =>
  defineTool({
    name: WEB_EXTRACT_TOOL_NAME,
    description:
      "Read web pages as text. Give the full http or https links, up to 5. Cite each fact you take from a page right after it with a Markdown link labeled source, such as [source](https://en.wikipedia.org/wiki/Bun_(software)). Give any link you want the owner to open descriptive text instead.",
    parameters: Type.Object({
      urls: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 5,
      }),
    }),
    callers: ["model"],
    replay: "safe",
    execute: async ({ urls }, _api, context) => {
      const pages = await Effect.runPromise(
        Effect.forEach(urls, (url) => extractPage(url, extract), {
          concurrency: "unbounded",
        }),
        { signal: context.abortSignal },
      );

      return {
        output: [
          {
            type: "text" as const,
            text: pages
              .map((page) =>
                "error" in page
                  ? `${page.url}\n${page.error}`
                  : `${page.title}\n${page.url}\n${page.text}`,
              )
              .join("\n\n"),
          },
        ],
        details: pages.map((page) =>
          "error" in page ? page : { url: page.url, title: page.title },
        ),
      };
    },
  });

export function webSearchExtension(
  providers: WebSearchProvider[],
  bot: string,
) {
  const search = providers.find((provider) => provider.search)?.search;
  const extract = providers.find((provider) => provider.extract)?.extract;
  const tools = [];

  if (search) tools.push(searchTool(search, bot));

  if (extract) tools.push(extractTool(extract));

  return defineExtension({ name: "web-search", tools });
}

export const configuredWebSearchTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = pluginWebSearchProviders(yield* Plugins);
    const agents = yield* AgentRepository;
    const settings = yield* SettingsRepository;
    const extensions = yield* BotExtensions;
    yield* extensions.register(ExtensionPosition.webSearch, (agent) => {
      if (!agent.tools.includes("web")) return [];

      const resolve = Effect.fnUntraced(function* () {
        const current = yield* agents.get(agent.id);

        const id =
          current?.webSearchProvider ??
          (yield* settings.get(DEFAULT_PROVIDER)) ??
          "mixed";

        return providers.find((provider) => provider.id === id);
      });

      const dynamic: WebSearchProvider = {
        id: "selected",
        search: (query, bot) =>
          resolve().pipe(
            Effect.flatMap((provider) =>
              provider?.search
                ? provider.search(query, bot)
                : Effect.fail(
                    new WebSearchError(
                      "The selected web search provider is unavailable or its API key is missing.",
                    ),
                  ),
            ),
          ),
        extract: (url) =>
          resolve().pipe(
            Effect.flatMap((provider) =>
              provider?.extract
                ? provider.extract(url)
                : Effect.fail(
                    new WebExtractionError(
                      "The selected web search provider is unavailable or its API key is missing.",
                    ),
                  ),
            ),
          ),
      };

      return [webSearchExtension([dynamic], agent.id)];
    });
  }),
);

export const webSearchTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = pluginWebSearchProviders(yield* Plugins);
    yield* (yield* BotExtensions).register(
      ExtensionPosition.webSearch,
      (agent) =>
        agent.tools.includes("web")
          ? [webSearchExtension(providers, agent.id)]
          : [],
    );
  }),
);

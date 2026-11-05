import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Layer } from "effect";
import { Plugins, pluginWebSearchProviders } from "../plugins/plugins";
import { BotExtensions, ExtensionPosition } from "../bot-ports/bot-extensions";
import { isPublicAddress } from "../shared/public-address";
import {
  defaultProvider,
  MAX_PAGE_CHARS,
  WebExtractionError,
  WebSearchError,
  type WebExtract,
  type WebSearch,
} from "./provider";
import { AgentRepository } from "../bot-store/agent-repository";
import { SettingsRepository } from "../shared/settings-repository";
import {
  BOT_TOOL,
  WEB_EXTRACT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../contract/tools";
import type { WebPage } from "../contract/web-search";

const refused = "Crumble does not read private or local addresses.";

const unavailable =
  "The selected web search provider is unavailable or its API key is missing.";

const date = Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }));

// Every address must be public: the provider resolves the name itself, so unlike the credential proxy, Crumble can't
// connect to only the public ones.
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
  extract: WebExtract,
) {
  if (!(yield* publicUrl(url)))
    return { url, error: refused } satisfies WebPage;

  const page = yield* extract(url).pipe(
    Effect.catch((error) =>
      Effect.succeed({ url, error: error.message } satisfies WebPage),
    ),
  );

  if ("error" in page || page.text.length <= MAX_PAGE_CHARS) return page;

  return {
    ...page,
    text: `${page.text.slice(0, MAX_PAGE_CHARS)}\n\n[Text truncated at ${MAX_PAGE_CHARS.toLocaleString("en-US")} characters.]`,
  };
});

const searchTool = (search: WebSearch, bot: string) =>
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

const extractTool = (extract: WebExtract) =>
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

/** The bot's web tools; both follow the bot's provider, read at each call, so changing it never changes the tools. */
export const configuredWebSearchTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = pluginWebSearchProviders(yield* Plugins);
    const agents = yield* AgentRepository;
    const settings = yield* SettingsRepository;
    const extensions = yield* BotExtensions;

    yield* extensions.register(ExtensionPosition.webSearch, (agent) => {
      if (!agent.tools.includes(BOT_TOOL.web)) return [];

      const resolve = Effect.fnUntraced(function* () {
        const current = yield* agents.get(agent.id);

        const id =
          current?.webSearchProvider ?? (yield* defaultProvider(settings));

        return providers.find((provider) => provider.id === id);
      });

      const search: WebSearch = (query, bot) =>
        resolve().pipe(
          Effect.flatMap((provider) =>
            provider?.search
              ? provider.search(query, bot)
              : Effect.fail(new WebSearchError({ message: unavailable })),
          ),
        );

      const extract: WebExtract = (url) =>
        resolve().pipe(
          Effect.flatMap((provider) =>
            provider?.extract
              ? provider.extract(url)
              : Effect.fail(new WebExtractionError({ message: unavailable })),
          ),
        );

      return [
        defineExtension({
          name: "web-search",
          tools: [searchTool(search, agent.id), extractTool(extract)],
        }),
      ];
    });
  }),
);

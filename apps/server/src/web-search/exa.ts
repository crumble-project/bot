import { Effect, Schema } from "effect";
import { pluginSettingKey, type CrumblePlugin } from "../plugins/plugins";
import {
  WebExtractionError,
  WebSearchError,
  type WebSearchProvider,
  type WebSearchResult,
} from "./provider";

const response = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optional(Schema.NullOr(Schema.String)),
      publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
      highlights: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      text: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const request = Effect.fnUntraced(
  function* (key: string, path: string, body: string) {
    const result = yield* Effect.tryPromise({
      try: async (signal) => {
        const res = await fetch(`https://api.exa.ai/${path}`, {
          method: "POST",
          headers: { "x-api-key": key, "content-type": "application/json" },
          body,
          signal,
        });

        if (!res.ok) throw new Error(`Exa returned HTTP ${res.status}`);

        const data: unknown = await res.json();

        return data;
      },
      catch: () =>
        new Error(
          "Exa request failed; check the API key and quota, then try again.",
        ),
    });

    return yield* Schema.decodeUnknownEffect(response)(result).pipe(
      Effect.mapError(() => new Error("Exa returned an invalid response.")),
    );
  },
  Effect.timeoutOrElse({
    duration: "30 seconds",
    orElse: () => Effect.fail(new Error("Exa request timed out.")),
  }),
);

const keyedExaProvider = (key: string): WebSearchProvider => ({
  id: "exa",
  search: (query) =>
    request(
      key,
      "search",
      JSON.stringify({
        query: query.query,
        numResults: query.limit,
        contents: { highlights: true },
        includeDomains: query.domains?.length ? query.domains : undefined,
        startPublishedDate: query.after
          ? `${query.after}T00:00:00.000Z`
          : undefined,
        endPublishedDate: query.before
          ? `${query.before}T23:59:59.999Z`
          : undefined,
      }),
    ).pipe(
      Effect.map(({ results }) =>
        results.map((item) => {
          const result: WebSearchResult = {
            url: item.url,
            title: item.title ?? item.url,
            excerpt: item.highlights?.join("\n") ?? item.text ?? "",
          };

          if (item.publishedDate) result.published = item.publishedDate;

          return result;
        }),
      ),
      Effect.mapError((error) => new WebSearchError(error.message)),
    ),
  extract: (url) =>
    request(
      key,
      "contents",
      JSON.stringify({
        urls: [url],
        text: { maxCharacters: 20000 },
      }),
    ).pipe(
      Effect.map(({ results }) => {
        const item = results[0];

        return item?.text
          ? { url, title: item.title ?? url, text: item.text }
          : { url, error: "Exa could not extract this page." };
      }),
      Effect.mapError((error) => new WebExtractionError(error.message)),
    ),
});

const exaProvider = (
  key: Effect.Effect<string | undefined>,
): WebSearchProvider => ({
  id: "exa",
  search: (query, bot) =>
    key.pipe(
      Effect.flatMap((value) =>
        value
          ? keyedExaProvider(value).search!(query, bot)
          : Effect.fail(new WebSearchError("Exa API key is not configured.")),
      ),
    ),
  extract: (url) =>
    key.pipe(
      Effect.flatMap((value) =>
        value
          ? keyedExaProvider(value).extract!(url)
          : Effect.fail(
              new WebExtractionError("Exa API key is not configured."),
            ),
      ),
    ),
});

export const EXA_PLUGIN_ID = "web-search-exa";

/** Where the Exa key is stored; the deprecated /v1/web-search/exa-key routes read it too. */
export const EXA_KEY = pluginSettingKey(EXA_PLUGIN_ID, "api-key");

export const exaPlugin = (
  secret: (key: string) => Effect.Effect<string | undefined>,
): CrumblePlugin => ({
  id: EXA_PLUGIN_ID,
  settings: [
    {
      key: "api-key",
      kind: "secret",
      label: "Exa API key",
      whenMissing: "Needed for Exa",
    },
  ],
  webSearchProviders: [exaProvider(secret(EXA_KEY))],
});

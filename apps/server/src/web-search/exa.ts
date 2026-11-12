import type { SecretUnavailable } from "../secrets/secret-values";
import { Effect, Schema } from "effect";
import type { CrumblePlugin } from "../plugins/plugins";
import { pluginSettingKey } from "../shared/vendors";
import {
  MAX_PAGE_CHARS,
  VENDOR_TIMEOUT,
  WebExtractionError,
  WebSearchError,
  type WebSearchProvider,
  type WebSearchQuery,
} from "./provider";
import type { WebSearchResult } from "../contract/web-search";

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
    duration: VENDOR_TIMEOUT,
    orElse: () => Effect.fail(new Error("Exa request timed out.")),
  }),
);

const keyedSearch = (key: string, query: WebSearchQuery) =>
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
    Effect.mapError((error) => new WebSearchError({ message: error.message })),
  );

const keyedExtract = (key: string, url: string) =>
  request(
    key,
    "contents",
    JSON.stringify({
      urls: [url],
      text: { maxCharacters: MAX_PAGE_CHARS },
    }),
  ).pipe(
    Effect.map(({ results }) => {
      const item = results[0];

      return item?.text
        ? { url, title: item.title ?? url, text: item.text }
        : { url, error: "Exa could not extract this page." };
    }),
    Effect.mapError(
      (error) => new WebExtractionError({ message: error.message }),
    ),
  );

const withKey = <A, E>(
  key: Effect.Effect<string | undefined, SecretUnavailable>,
  failure: (message: string) => E,
  use: (value: string) => Effect.Effect<A, E>,
) =>
  key.pipe(
    Effect.mapError((error) => failure(error.message)),
    Effect.flatMap((value) =>
      value
        ? use(value)
        : Effect.fail(failure("Exa API key is not configured.")),
    ),
  );

const exaProvider = (
  key: Effect.Effect<string | undefined, SecretUnavailable>,
): WebSearchProvider => ({
  id: "exa",
  search: (query) =>
    withKey(
      key,
      (message) => new WebSearchError({ message }),
      (value) => keyedSearch(value, query),
    ),
  extract: (url) =>
    withKey(
      key,
      (message) => new WebExtractionError({ message }),
      (value) => keyedExtract(value, url),
    ),
});

export const EXA_PLUGIN_ID = "web-search-exa";

const EXA_KEY_SETTING = "api-key";

export const EXA_KEY = pluginSettingKey(EXA_PLUGIN_ID, EXA_KEY_SETTING);

export const exaPlugin = (
  secret: (key: string) => Effect.Effect<string | undefined, SecretUnavailable>,
): CrumblePlugin => ({
  id: EXA_PLUGIN_ID,
  settings: [
    {
      key: EXA_KEY_SETTING,
      kind: "secret",
      label: "Exa API key",
      whenMissing: "Needed for Exa",
    },
  ],
  webSearchProviders: [exaProvider(secret(EXA_KEY))],
});

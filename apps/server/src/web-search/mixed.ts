import { Effect, Result, Semaphore } from "effect";
import type { CrumblePlugin } from "../app/plugins";
import {
  WebExtractionError,
  WebSearchError,
  type WebSearchProvider,
  type WebSearchQuery,
  type WebSearchResult,
} from "./provider";
import {
  exaSearch,
  jinaExtract,
  parallelSearch,
  tavilySearch,
  VendorUnavailable,
} from "./vendors";

export class WebSearchUnavailable extends WebSearchError {
  constructor() {
    super(
      "Web search is unavailable right now: the free services Crumble uses are rate-limited or down. Try again later.",
    );
  }
}

const matchesDomains = (url: string, domains: string[]) => {
  if (!domains.length) return true;
  let hostname: string;

  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  return domains.some((domain) => {
    const normalized = domain.toLowerCase();

    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
};

const matchesDate = (published: string | undefined, query: WebSearchQuery) => {
  if (!published) return true;
  const date = published.slice(0, 10);

  return (
    !(query.after && date < query.after) &&
    !(query.before && date > query.before)
  );
};

const filterResults = (results: WebSearchResult[], query: WebSearchQuery) =>
  results
    .filter(
      (result) =>
        matchesDomains(result.url, query.domains ?? []) &&
        matchesDate(result.published, query),
    )
    .slice(0, query.limit);

const makeParallelSearch = () => {
  const sessions = new Map<string, string>();
  const initializers = new Map<string, Semaphore.Semaphore>();

  return Effect.fnUntraced(function* (query: WebSearchQuery, bot: string) {
    if (!sessions.has(bot)) {
      let initializer = initializers.get(bot);

      if (!initializer) {
        initializer = Semaphore.makeUnsafe(1);
        initializers.set(bot, initializer);
      }

      const initialized = yield* initializer.withPermit(
        Effect.gen(function* () {
          if (sessions.has(bot)) return undefined;
          const response = yield* parallelSearch(query);

          if (response.sessionId !== undefined)
            sessions.set(bot, response.sessionId);

          return response.results;
        }),
      );

      if (initialized !== undefined) return initialized;
    }

    return (yield* parallelSearch(query, sessions.get(bot))).results;
  });
};

export const mixedProvider = (): WebSearchProvider => {
  let cursor = 0;
  const searchParallel = makeParallelSearch();

  const search = Effect.fnUntraced(function* (
    query: WebSearchQuery,
    bot: string,
  ) {
    const start = cursor;

    cursor = (cursor + 1) % 3;

    const vendors = [
      () => exaSearch(query),
      () => searchParallel(query, bot),
      () => tavilySearch(query),
    ];

    for (let i = 0; i < vendors.length; i++) {
      const vendor = vendors[(start + i) % vendors.length];

      if (!vendor) continue;

      const result = yield* vendor().pipe(Effect.result);

      if (Result.isSuccess(result)) return filterResults(result.success, query);

      if (!(result.failure instanceof VendorUnavailable))
        return yield* Effect.fail(result.failure);
    }

    return yield* Effect.fail(new WebSearchUnavailable());
  });

  return {
    id: "mixed",
    search,
    extract: (url) =>
      jinaExtract(url).pipe(
        Effect.mapError(
          (error) => new WebExtractionError(error.message, { cause: error }),
        ),
      ),
  };
};

export const webSearchPlugin = (): CrumblePlugin => ({
  id: "web-search",
  webSearchProviders: [mixedProvider()],
});

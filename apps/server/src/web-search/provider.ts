import type { Effect } from "effect";
import type { WebPage, WebSearchResult } from "../contract/web-search";

export class WebSearchError extends Error {}

export class WebExtractionError extends Error {}

/** The most text one page gives a bot. */
export const MAX_PAGE_CHARS = 20000;

/** How long a vendor may take to answer. */
export const VENDOR_TIMEOUT = "30 seconds";

export type WebSearchQuery = {
  query: string;
  limit: number;
  domains?: string[];
  after?: string;
  before?: string;
};

export type WebSearch = (
  query: WebSearchQuery,
  bot: string,
) => Effect.Effect<WebSearchResult[], WebSearchError>;

export type WebExtract = (
  url: string,
) => Effect.Effect<WebPage, WebExtractionError>;

/** A web search provider, which may support only one of the two; see docs/adr/0007-web-search-providers.md. */
export type WebSearchProvider = {
  /** Settings key on it: never rename. */
  id: string;
  search?: WebSearch;
  extract?: WebExtract;
};

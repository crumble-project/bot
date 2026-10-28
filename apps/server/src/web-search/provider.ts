import type { Effect } from "effect";
import { z } from "zod";

export const WEB_SEARCH_TOOL_NAME = "web_search";

export const WEB_EXTRACT_TOOL_NAME = "web_extract";

/** A page a bot searched or read, which its reply may cite. */
export const webSource = z.object({ url: z.string(), title: z.string() });

export type WebSource = z.infer<typeof webSource>;

export class WebSearchError extends Error {}

export class WebExtractionError extends Error {}

export type WebSearchQuery = {
  query: string;
  limit: number;
  domains?: string[];
  after?: string;
  before?: string;
};

export type WebSearchResult = {
  title: string;
  url: string;
  published?: string;
  excerpt: string;
};

export type WebPage =
  | { url: string; title: string; text: string }
  | { url: string; error: string };

/** A web search provider; see docs/adr/0007-web-search-providers.md. */
export type WebSearchProvider = {
  /** Settings key on it: never rename. */
  id: string;
  search?: (
    query: WebSearchQuery,
    bot: string,
  ) => Effect.Effect<WebSearchResult[], WebSearchError>;
  extract?: (url: string) => Effect.Effect<WebPage, WebExtractionError>;
};

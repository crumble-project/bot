import { Effect, Schema } from "effect";
import { z } from "zod";
import type { WebPage, WebSearchResult } from "../contract/web-search";
import type { SettingsRepository } from "../shared/settings-repository";
import { WEB_SEARCH_PROVIDER_IDS } from "../shared/vendors";

export class WebSearchError extends Schema.TaggedError<WebSearchError>()(
  "WebSearchError",
  { message: Schema.String },
) {}

export class WebExtractionError extends Schema.TaggedError<WebExtractionError>()(
  "WebExtractionError",
  { message: Schema.String },
) {}

export const DEFAULT_PROVIDER = "web-search:default-provider";

/** The account's default provider; a stored value this server doesn't know reads as Mixed. */
export const defaultProvider = (settings: SettingsRepository["Service"]) =>
  Effect.map(settings.get(DEFAULT_PROVIDER), (stored) =>
    z.enum(WEB_SEARCH_PROVIDER_IDS).catch("mixed").parse(stored),
  );

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

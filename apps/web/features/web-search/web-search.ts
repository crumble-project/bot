import { WEB_SEARCH_PROVIDER_IDS } from "@crumble/server/contract/web-search";

type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

/** A provider the server adds needs a name here. */
const NAMES = {
  mixed: "Mixed",
  exa: "Exa",
} satisfies Record<WebSearchProviderId, string>;

export const webSearchProviders = WEB_SEARCH_PROVIDER_IDS.map((id) => ({
  id,
  name: NAMES[id],
}));

export const isWebSearchProviderId = (
  value: string,
): value is WebSearchProviderId =>
  WEB_SEARCH_PROVIDER_IDS.some((id) => id === value);

import { z } from "zod";
// Bound by name, not re-exported: `web` may import `contract`, never `shared`.
export { WEB_SEARCH_PROVIDER_IDS } from "../shared/vendors";

export const webSource = z.object({ url: z.string(), title: z.string() });

export type WebSource = z.infer<typeof webSource>;

export type WebSearchResult = {
  title: string;
  url: string;
  published?: string;
  excerpt: string;
};

export type WebPage =
  | { url: string; title: string; text: string }
  | { url: string; error: string };

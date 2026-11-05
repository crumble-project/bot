import { z } from "zod";

/** A page a bot searched or read, which its reply may cite. */
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

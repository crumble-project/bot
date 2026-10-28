import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { Effect } from "effect";
import { z } from "zod";
import type { WebSearchQuery, WebSearchResult } from "./provider";

export class VendorUnavailable extends Error {}

const parallelResponse = z.object({
  session_id: z.string().optional(),
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      excerpts: z.array(z.string()),
      publish_date: z.string().nullish(),
    }),
  ),
});

const tavilyResponse = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      content: z.string(),
      published_date: z.string().nullish(),
    }),
  ),
});

const jinaResponse = z.object({
  data: z.object({
    url: z.string(),
    title: z.string(),
    content: z.string(),
    httpStatus: z.number().optional(),
  }),
});

const unavailable = (name: string, cause: unknown) =>
  cause instanceof VendorUnavailable
    ? cause
    : new VendorUnavailable(
        `${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );

const timed = <A>(name: string, effect: Effect.Effect<A, VendorUnavailable>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(new VendorUnavailable(`${name}: timeout`)),
    }),
  );

const mcpCall = (
  name: string,
  url: string,
  tool: string,
  args: {
    objective: string;
    query?: string;
    numResults?: number;
    search_queries?: string[];
    session_id?: string;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new McpClient({ name: "crumble", version: "1.0.0" })),
        (client) => Effect.promise(() => client.close()),
      );

      yield* Effect.tryPromise({
        try: (signal) =>
          client.connect(
            new StreamableHttpTransport({
              url: new URL(url),
              headers: { "User-Agent": "crumble" },
              fetch: async (input, init) => {
                const response = await fetch(input, {
                  ...init,
                  signal: AbortSignal.any([
                    signal,
                    ...(init?.signal ? [init.signal] : []),
                  ]),
                });

                if (!response.ok)
                  throw new VendorUnavailable(
                    `${name}: HTTP ${response.status}`,
                  );

                return response;
              },
            }),
          ),
        catch: (cause) => unavailable(name, cause),
      });

      const result = yield* Effect.tryPromise({
        try: (signal) => client.callTool(tool, args, { signal }),
        catch: (cause) => unavailable(name, cause),
      });

      if (result.isError)
        return yield* Effect.fail(
          new VendorUnavailable(`${name}: MCP tool error`),
        );

      return result;
    }),
  );

export const exaSearch = (query: WebSearchQuery) =>
  timed(
    "Exa",
    Effect.gen(function* () {
      const result = yield* mcpCall(
        "Exa",
        "https://mcp.exa.ai/mcp",
        "web_search_exa",
        {
          query: query.query,
          objective: query.query,
          numResults: query.limit,
        },
      );

      return yield* Effect.try({
        try: () => {
          const blocks = result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text);

          if (!blocks.length) throw new Error("unexpected response shape");

          return blocks
            .flatMap((text) => text.split(/\n---\s*\n(?=\s*Title:)/))
            .map((block) => {
              const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim();
              const url = /^URL:\s*(.+)$/m.exec(block)?.[1]?.trim();
              const published = /^Published:\s*(.+)$/m.exec(block)?.[1]?.trim();

              const excerpt = /(?:^|\n)Highlights:\s*([\s\S]*)/
                .exec(block)?.[1]
                ?.trim();

              if (!title || !url || excerpt === undefined)
                throw new Error("unexpected response shape");
              const item: WebSearchResult = { title, url, excerpt };

              if (published && published !== "N/A") item.published = published;

              return item;
            });
        },
        catch: (cause) => unavailable("Exa", cause),
      });
    }),
  );

export const parallelSearch = (query: WebSearchQuery, sessionId?: string) =>
  timed(
    "Parallel",
    Effect.gen(function* () {
      const args: Parameters<typeof mcpCall>[3] = {
        objective: query.query,
        search_queries: [query.query],
      };

      if (sessionId !== undefined) args.session_id = sessionId;

      const result = yield* mcpCall(
        "Parallel",
        "https://mcp.parallel.ai/mcp",
        "web_search",
        args,
      );

      return yield* Effect.try({
        try: () => {
          const text = result.content.find((block) => block.type === "text");

          if (!text || text.type !== "text")
            throw new Error("unexpected response shape");
          const response = parallelResponse.parse(JSON.parse(text.text));

          const results = response.results.map((item) => {
            const mapped: WebSearchResult = {
              title: item.title ?? item.url,
              url: item.url,
              excerpt: item.excerpts.join("\n\n"),
            };

            if (item.publish_date) mapped.published = item.publish_date;

            return mapped;
          });

          return { results, sessionId: response.session_id };
        },
        catch: (cause) => unavailable("Parallel", cause),
      });
    }),
  );

const fetchJson = (name: string, url: string, init: RequestInit) =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );

      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            ...init,
            signal: AbortSignal.any([signal, controller.signal]),
          }),
        catch: (cause) => unavailable(name, cause),
      });

      if (!response.ok)
        return yield* Effect.fail(
          new VendorUnavailable(`${name}: HTTP ${response.status}`),
        );

      return yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => unavailable(name, cause),
      });
    }),
  );

export const tavilySearch = (query: WebSearchQuery) =>
  timed(
    "Tavily",
    Effect.gen(function* () {
      const response = yield* fetchJson(
        "Tavily",
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: {
            "User-Agent": "crumble",
            "Content-Type": "application/json",
            "X-Tavily-Access-Mode": "keyless",
          },
          body: JSON.stringify({
            query: query.query,
            max_results: query.limit,
            include_domains: query.domains,
            start_date: query.after,
            end_date: query.before,
          }),
        },
      );

      const data = yield* Effect.try({
        try: () => tavilyResponse.parse(response),
        catch: (cause) => unavailable("Tavily", cause),
      });

      return data.results.map((item) => {
        const mapped: WebSearchResult = {
          title: item.title,
          url: item.url,
          excerpt: item.content,
        };

        if (item.published_date) mapped.published = item.published_date;

        return mapped;
      });
    }),
  );

export const jinaExtract = (url: string) =>
  timed(
    "Jina",
    Effect.gen(function* () {
      const response = yield* fetchJson("Jina", `https://r.jina.ai/${url}`, {
        headers: { "User-Agent": "crumble", Accept: "application/json" },
      });

      const { data } = yield* Effect.try({
        try: () => jinaResponse.parse(response),
        catch: (cause) => unavailable("Jina", cause),
      });

      if (data.httpStatus && data.httpStatus >= 400)
        return yield* Effect.fail(
          new VendorUnavailable(`Jina: HTTP ${data.httpStatus}`),
        );

      return { url: data.url, title: data.title, text: data.content };
    }),
  );

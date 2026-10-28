import { expect, mock, test } from "bun:test";
import { Effect } from "effect";
import type { WebSearchQuery, WebSearchResult } from "./provider";

class VendorUnavailable extends Error {}

type Response = { results: WebSearchResult[]; sessionId?: string };

let parallel: (
  query: WebSearchQuery,
  sessionId?: string,
) => Effect.Effect<Response, VendorUnavailable>;

await mock.module("./vendors", () => ({
  VendorUnavailable,
  exaSearch: () => Effect.fail(new VendorUnavailable()),
  tavilySearch: () => Effect.fail(new VendorUnavailable()),
  jinaExtract: () => Effect.die("unexpected extraction"),
  parallelSearch: (query: WebSearchQuery, sessionId?: string) =>
    parallel(query, sessionId),
}));

const { mixedProvider } = await import("./mixed");
const query = { query: "test", limit: 5 };

test("concurrent initial searches reuse the bot's Parallel session and do not block other bots", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  parallel = (input, sessionId) =>
    Effect.promise(async () => {
      calls.push([input.query, sessionId]);

      if (input.query === "first") {
        started.resolve();
        await gate.promise;
      }

      return { results: [], sessionId: `${input.query}-session` };
    });

  const search = mixedProvider().search;

  if (!search) throw new Error("search unavailable");

  const first = Effect.runPromise(
    search({ ...query, query: "first" }, "bot-a"),
  );

  await started.promise;

  const second = Effect.runPromise(
    search({ ...query, query: "second" }, "bot-a"),
  );

  await Effect.runPromise(search({ ...query, query: "other" }, "bot-b"));

  expect(calls).toEqual([
    ["first", undefined],
    ["other", undefined],
  ]);

  gate.resolve();
  await Promise.all([first, second]);
  expect(calls).toEqual([
    ["first", undefined],
    ["other", undefined],
    ["second", "first-session"],
  ]);
  await Effect.runPromise(search(query, "bot-a"));
  expect(calls.at(-1)).toEqual(["test", "first-session"]);
});

test.each(["failure", "interruption"] as const)(
  "waiting search proceeds after initialization %s",
  async (mode) => {
    const calls: Array<string | undefined> = [];
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();

    parallel = (_input, sessionId) => {
      calls.push(sessionId);

      if (calls.length !== 1)
        return Effect.succeed({ results: [], sessionId: "recovered" });

      started.resolve();

      return Effect.promise(() => gate.promise).pipe(
        Effect.andThen(Effect.fail(new VendorUnavailable())),
      );
    };

    const search = mixedProvider().search;

    if (!search) throw new Error("search unavailable");

    const controller = new AbortController();

    const first = Effect.runPromise(search(query, "bot-a"), {
      signal: controller.signal,
    }).catch(() => undefined);

    await started.promise;

    const second = Effect.runPromise(search(query, "bot-a"));

    if (mode === "failure") {
      gate.resolve();
    } else {
      controller.abort();
    }

    await Promise.all([first, second]);
    await Effect.runPromise(search(query, "bot-a"));
    expect(calls).toEqual([undefined, undefined, "recovered"]);
  },
);

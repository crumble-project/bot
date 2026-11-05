import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Store } from "../../test/support/store";
import type { CoreServices } from "../app/core-layer";
import { BotExtensions } from "../bots/bot-extensions";
import { WEB_SEARCH_TOOL_NAME } from "../contract/tools";
import { Plugins } from "../plugins/plugins";
import { agentInput } from "../contract/agents";
import { configuredWebSearchTools } from "./web-search-tools";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const RESULT = { url: "https://mixed.test", title: "Mixed", excerpt: "" };

test("a stored default this server doesn't know searches with Mixed, as Settings shows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-web-search-"));
  dirs.push(dir);

  const store = new Store(dir);

  const agent = store.createAgent(
    agentInput.parse({ name: "Bot", tools: ["web"] }),
  );

  store.setSetting("web-search:default-provider", "dropped");

  const layers = configuredWebSearchTools.pipe(
    Layer.provideMerge(BotExtensions.layer),
    Layer.provide(
      Layer.succeed(Plugins, [
        {
          id: "offline",
          webSearchProviders: [
            { id: "mixed", search: () => Effect.succeed([RESULT]) },
          ],
        },
      ]),
    ),
    Layer.provide(
      Layer.succeedContext(store.run(Effect.context<CoreServices>())),
    ),
  );

  const [extension] = await Effect.runPromise(
    BotExtensions.use((registry) =>
      Effect.promise(() => registry.forAgent(agent)),
    ).pipe(Effect.scoped, Effect.provide(layers)),
  );

  const search = extension?.tools?.find(
    (tool) => tool.name === WEB_SEARCH_TOOL_NAME,
  );

  // SAFETY: the web tools read only the context's abort signal.
  const context = { abortSignal: new AbortController().signal } as never;

  // SAFETY: the web tools never touch the tool API.
  const result = await search?.execute(
    { query: "crumble" },
    undefined as never,
    context,
  );

  expect(result?.details).toEqual([RESULT]);
  store.close();
});

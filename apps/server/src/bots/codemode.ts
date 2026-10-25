import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { Effect, Layer } from "effect";
import { McpIntegrations } from "../integrations/integrations";
import { BotExtensions, ExtensionPosition } from "./bot-extensions";

/** Offers bots with code mode a QuickJS sandbox that calls their MCP tools; the layer's scope closes the sandbox. */
export const codemodeTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const integrations = yield* McpIntegrations;

    const sandbox = yield* Effect.acquireRelease(
      Effect.sync(
        () => new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }),
      ),
      (opened) => Effect.promise(async () => opened.close()),
    );

    yield* (yield* BotExtensions).register(
      ExtensionPosition.codemode,
      (agent) =>
        agent.tools.includes("codemode")
          ? [
              createCodemodeExtension({
                sandbox,
                namespaces: integrations.codemodeNamespaces(agent),
              }),
            ]
          : [],
    );
  }),
);

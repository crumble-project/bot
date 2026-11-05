import type { Extension } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Ref, type Scope } from "effect";
import type { Agent } from "../contract/agents";

export type ExtensionSource = (
  agent: Agent,
) => Extension[] | Promise<Extension[]>;

export class BotExtensions extends Context.Service<
  BotExtensions,
  {
    /** Offers `source`'s extensions until the scope closes; lower positions come first. */
    readonly register: (
      position: number,
      source: ExtensionSource,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly forAgent: (agent: Agent) => Promise<Extension[]>;
  }
>()("crumble/bot-ports/BotExtensions") {
  static readonly layer = Layer.effect(
    BotExtensions,
    Effect.gen(function* () {
      const sources = yield* Ref.make<
        ReadonlyArray<{ position: number; source: ExtensionSource }>
      >([]);

      const register = (position: number, source: ExtensionSource) =>
        Effect.acquireRelease(
          Ref.update(sources, (current) =>
            [...current, { position, source }].sort(
              (a, b) => a.position - b.position,
            ),
          ),
          () =>
            Ref.update(sources, (current) =>
              current.filter((entry) => entry.source !== source),
            ),
        );

      const forAgent = async (agent: Agent) => {
        const current = Effect.runSync(Ref.get(sources));

        return (
          await Promise.all(current.map(async (entry) => entry.source(agent)))
        ).flat();
      };

      return BotExtensions.of({ register, forAgent });
    }),
  );
}

export const ExtensionPosition = {
  integrations: 10,
  coordination: 20,
  groupLookup: 30,
  historyTools: 40,
  schedules: 50,
  eventPayload: 55,
  display: 60,
  desktopScreenshot: 62,
  webSearch: 65,
  reaction: 70,
  jobs: 80,
  botRequests: 85,
  codemode: 90,
} as const;

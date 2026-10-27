import type { Extension } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Ref, type Scope } from "effect";
import type { Agent } from "../shared/domain";

/** One feature's extensions for a bot's chat. */
export type ExtensionSource = (
  agent: Agent,
) => Extension[] | Promise<Extension[]>;

/**
 * The extensions each bot's chat offers, registered by the features that own them. The bot runtime reads them at turn
 * time, so it need not depend on every feature whose tools it offers.
 */
export class BotExtensions extends Context.Service<
  BotExtensions,
  {
    /** Offers `source`'s extensions until the scope closes; lower positions come first. */
    readonly register: (
      position: number,
      source: ExtensionSource,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** Every registered feature's extensions for `agent`, in position order. */
    readonly forAgent: (agent: Agent) => Promise<Extension[]>;
  }
>()("crumble/bots/BotExtensions") {
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

/** Where each feature's extensions appear in a bot's chat, in the order bots were offered them before the registry. */
export const ExtensionPosition = {
  integrations: 10,
  coordination: 20,
  groupLookup: 30,
  historyTools: 40,
  schedules: 50,
  display: 60,
  reaction: 70,
  jobs: 80,
  botRequests: 85,
  codemode: 90,
} as const;

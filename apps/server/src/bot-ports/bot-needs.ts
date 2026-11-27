import { Context, Effect, Layer, Ref } from "effect";
import type { Scope } from "effect";

export type BotNeed = "blocked" | "question" | "working";

const STRENGTH: Record<BotNeed, number> = {
  blocked: 3,
  question: 2,
  working: 1,
};

export type NeedSource = (
  agentId: string,
) => Effect.Effect<BotNeed | undefined>;

export const strongest = (
  needs: ReadonlyArray<BotNeed | undefined>,
): BotNeed | undefined =>
  needs.reduce<BotNeed | undefined>(
    (best, need) =>
      need && (!best || STRENGTH[need] > STRENGTH[best]) ? need : best,
    undefined,
  );

export const needWhen =
  (need: BotNeed, pending: (agentId: string) => Effect.Effect<boolean>) =>
  (agentId: string) =>
    Effect.map(pending(agentId), (found) => (found ? need : undefined));

export class BotNeeds extends Context.Service<
  BotNeeds,
  {
    readonly provide: (
      source: NeedSource,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly current: (agentId: string) => Effect.Effect<BotNeed | undefined>;
    readonly changed: (agentId: string) => Effect.Effect<void>;
    readonly onChanged: (listener: (agentId: string) => void) => () => void;
  }
>()("crumble/bot-ports/BotNeeds") {
  static readonly layer = Layer.effect(
    BotNeeds,
    Effect.gen(function* () {
      const sources = yield* Ref.make<ReadonlyArray<NeedSource>>([]);
      const listeners = new Set<(agentId: string) => void>();

      return BotNeeds.of({
        provide: (source) =>
          Effect.acquireRelease(
            Ref.update(sources, (current) => [...current, source]),
            () =>
              Ref.update(sources, (current) =>
                current.filter((each) => each !== source),
              ),
          ),
        current: (agentId) =>
          Effect.flatMap(Ref.get(sources), (current) =>
            Effect.map(
              Effect.forEach(current, (source) => source(agentId), {
                concurrency: "unbounded",
              }),
              strongest,
            ),
          ),
        changed: (agentId) =>
          Effect.sync(() => {
            for (const listener of listeners) {
              listener(agentId);
            }
          }),
        onChanged: (listener) => {
          listeners.add(listener);

          return () => void listeners.delete(listener);
        },
      });
    }),
  );
}

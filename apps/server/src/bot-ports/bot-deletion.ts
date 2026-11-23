import { Context, Effect, Layer, Ref } from "effect";
import type { Scope } from "effect";

export type BotCleanup = (
  agentId: string,
) => Effect.Effect<Effect.Effect<void>>;

export class BotDeletion extends Context.Service<
  BotDeletion,
  {
    readonly register: (
      cleanup: BotCleanup,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly prepare: (agentId: string) => Effect.Effect<Effect.Effect<void>>;
  }
>()("crumble/bot-ports/BotDeletion") {
  static readonly layer = Layer.effect(
    BotDeletion,
    Effect.gen(function* () {
      const cleanups = yield* Ref.make<ReadonlyArray<BotCleanup>>([]);

      return BotDeletion.of({
        register: (cleanup) =>
          Effect.acquireRelease(
            Ref.update(cleanups, (current) => [...current, cleanup]),
            () =>
              Ref.update(cleanups, (current) =>
                current.filter((each) => each !== cleanup),
              ),
          ),
        prepare: (agentId) =>
          Effect.gen(function* () {
            const after = yield* Effect.forEach(
              yield* Ref.get(cleanups),
              (cleanup) => cleanup(agentId),
            );

            return Effect.forEach(after, (clear) => clear, { discard: true });
          }),
      });
    }),
  );
}

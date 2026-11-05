import { Context, Effect, Layer, Ref, type Scope } from "effect";

/**
 * One feature's part in deleting a bot. It runs while the bot still exists, to read what the delete's cascade takes,
 * and answers what to clear once the bot is gone.
 */
export type BotCleanup = (
  agentId: string,
) => Effect.Effect<Effect.Effect<void>>;

/** What deleting a bot clears beyond its rows, registered by the features that own it, so every delete path gets it. */
export class BotDeletion extends Context.Service<
  BotDeletion,
  {
    /** Runs `cleanup` for each bot deleted until the scope closes. */
    readonly register: (
      cleanup: BotCleanup,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** Asks every feature what it will clear for the bot; run the answer after the delete. */
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

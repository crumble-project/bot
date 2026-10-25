import { Effect, type Context, type Fiber } from "effect";

/** Runs effects that need `R` from code outside Effect; a ManagedRuntime is one, and `runnerOf` makes one from a context. */
export type Runner<R> = {
  runSync<A, E>(effect: Effect.Effect<A, E, R>): A;
  runPromise<A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<A>;
  runFork<A, E>(effect: Effect.Effect<A, E, R>): Fiber.Fiber<A, unknown>;
};

/** A runner over the services in `context`, such as a layer's own, for the plain code that layer builds. */
export const runnerOf = <R>(context: Context.Context<R>): Runner<R> => ({
  runSync: Effect.runSyncWith(context),
  runPromise: Effect.runPromiseWith(context),
  runFork: Effect.runForkWith(context),
});

import { Context, Effect, Predicate, type Fiber } from "effect";

export type Runner<R> = {
  runSync<A, E>(effect: Effect.Effect<A, E, R>): A;
  runPromise<A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<A>;
  runFork<A, E>(effect: Effect.Effect<A, E, R>): Fiber.Fiber<A, unknown>;
};

export const runnerOf = <R>(context: Context.Context<R>): Runner<R> => ({
  runSync: Effect.runSyncWith(context),
  runPromise: Effect.runPromiseWith(context),
  runFork: Effect.runForkWith(context),
});

export const noServices = runnerOf(Context.empty());

/** A service's effects as plain calls for code outside Effect: members named in `Sync` return their value, others a Promise. */
export type Access<S, Sync extends keyof S = never> = {
  readonly [K in keyof S]: S[K] extends Effect.Effect<infer A, unknown, unknown>
    ? () => K extends Sync ? A : Promise<A>
    : S[K] extends (
          ...args: infer P
        ) => Effect.Effect<infer A, unknown, unknown>
      ? (...args: P) => K extends Sync ? A : Promise<A>
      : S[K];
};

export function accessOf<S extends object, const Sync extends keyof S = never>(
  service: S,
  runner: Runner<never>,
  sync: readonly Sync[] = [],
): Access<S, Sync> {
  // SAFETY: a service's effects need nothing beyond what `runner` provides; `Runner<never>` accepts every runner.
  const run = (
    key: string,
    effect: Effect.Effect<unknown, unknown, unknown>,
  ) =>
    sync.some((name) => name === key)
      ? runner.runSync(effect as Effect.Effect<unknown>)
      : runner.runPromise(effect as Effect.Effect<unknown>);

  // SAFETY: this walk over the members is what the mapped type describes.
  return Object.fromEntries(
    Object.entries(service).map(([key, member]) => [
      key,
      Effect.isEffect(member)
        ? () => run(key, member)
        : Predicate.isFunction(member)
          ? (...args: unknown[]) => {
              const result = member(...args);

              return Effect.isEffect(result) ? run(key, result) : result;
            }
          : member,
    ]),
  ) as Access<S, Sync>;
}

import { Context, Effect, Layer, Predicate } from "effect";
import type { Fiber } from "effect";

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

/** The services a runner holds, as a layer for a runtime built on top of it. */
export const layerOfRunner = <R>(runner: Runner<R>) =>
  Layer.succeedContext(runner.runSync(Effect.context<R>()));

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

/**
 * Whether `access` holds an entry for every member of `service`, and a call where the service has an effect or a
 * function. `accessOf` builds it from those members, so this restates the shape for the type system and fails loudly
 * if a member goes missing or stays an effect.
 */
const isAccessOf = <S extends object, Sync extends keyof S>(
  access: unknown,
  service: S,
): access is Access<S, Sync> => {
  if (typeof access !== "object" || access === null) {
    return false;
  }

  return Object.keys(service).every((key) => {
    if (!Predicate.hasProperty(access, key)) {
      return false;
    }

    const member = Predicate.hasProperty(service, key)
      ? service[key]
      : undefined;

    return Effect.isEffect(member) || Predicate.isFunction(member)
      ? Predicate.isFunction(access[key])
      : true;
  });
};

/**
 * `runner` runs the service's effects: it was built from the layer the service came from, so its context satisfies
 * what they ask for. An effect that asks for something the runner's context lacks fails as a defect.
 */
export function accessOf<S extends object, const Sync extends keyof S = never>(
  service: S,
  runner: Runner<unknown>,
  sync: ReadonlyArray<Sync> = [],
): Access<S, Sync> {
  const run = (
    key: string,
    effect: Effect.Effect<unknown, unknown, unknown>,
  ) =>
    sync.some((name) => name === key)
      ? runner.runSync(effect)
      : runner.runPromise(effect);

  const memberOf = (key: string, member: unknown) => {
    if (Effect.isEffect(member)) {
      return () => run(key, member);
    }

    if (!Predicate.isFunction(member)) {
      return member;
    }

    return (...args: Array<unknown>) => {
      const result: unknown = member.call(undefined, ...args);

      return Effect.isEffect(result) ? run(key, result) : result;
    };
  };

  const access = Object.fromEntries(
    Object.keys(service).map((key) => [
      key,
      memberOf(
        key,
        Predicate.hasProperty(service, key) ? service[key] : undefined,
      ),
    ]),
  );

  if (!isAccessOf<S, Sync>(access, service)) {
    throw new Error("An access object could not be built for this service");
  }

  return access;
}

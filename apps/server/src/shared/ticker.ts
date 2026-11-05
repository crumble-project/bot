import { Clock, Effect, type Scope } from "effect";

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export const pruneHourly = <E, R>(prune: Effect.Effect<void, E, R>) => {
  let dueAt = 0;

  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (now < dueAt) return;
    dueAt = now + PRUNE_INTERVAL_MS;
    yield* prune;
  });
};

export const startTicking = (tick: Effect.Effect<void>, scope: Scope.Scope) => {
  let started = false;

  return Effect.gen(function* () {
    if (started) return;
    started = true;
    yield* Effect.gen(function* () {
      while (true) {
        yield* tick;
        yield* Effect.sleep("1 second");
      }
    }).pipe(Effect.forkIn(scope));
  });
};

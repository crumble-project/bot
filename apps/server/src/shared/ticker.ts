import { Effect, type Scope } from "effect";

/** Runs `tick` every second in `scope`, starting on the first run of the returned effect; later runs do nothing. */
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

import { Cause, Effect } from "effect";
import { isAppError } from "./errors";

/** Fails with the AppErrors an operation raises; anything else it throws is a defect. */
export const appErrors = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.catch((error) =>
      isAppError(error) ? Effect.fail(error) : Effect.die(error),
    ),
  );

/** A Pi Durable call: AppErrors it throws are failures, anything else is a defect. */
export const pi = <A>(run: () => Promise<A>) =>
  appErrors(Effect.tryPromise({ try: run, catch: (error) => error }));

/** Ends background work that failed with a log line, so nothing above it sees the failure. */
export const logged = (label: string, ...subjects: string[]) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Effect.logError(label, ...subjects, Cause.squash(cause)),
  );

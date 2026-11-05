import { Cause, Effect } from "effect";
import { isAppError } from "./errors";

export const appErrors = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.catch((error) =>
      isAppError(error) ? Effect.fail(error) : Effect.die(error),
    ),
  );

export const pi = <A>(run: () => Promise<A>) =>
  appErrors(Effect.tryPromise({ try: run, catch: (error) => error }));

export const logged = (label: string, ...subjects: string[]) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Effect.logError(label, ...subjects, Cause.squash(cause)),
  );

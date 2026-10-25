import { Effect } from "effect";
import { isAppError } from "./errors";

/** Fails with the AppErrors an operation raises; anything else it throws is a defect. */
export const appErrors = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.catch((error) =>
      isAppError(error) ? Effect.fail(error) : Effect.die(error),
    ),
  );

import { Effect } from "effect";
import { AppError } from "./domain";

/** Fails with the AppErrors an operation raises; anything else it throws is a defect. */
export const appErrors = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.catch((error) =>
      error instanceof AppError ? Effect.fail(error) : Effect.die(error),
    ),
  );

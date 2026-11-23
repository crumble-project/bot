import type { z } from "zod";

/**
 * A schema that parses to `fallback` when its input does not match: `schema.catch(fallback)`.
 *
 * The wrapper keeps the call out of module scope, where the lint rules read a top-level `.catch` as a promise chain.
 */
export const fallingBackTo = <S extends z.ZodType>(
  schema: S,
  fallback: z.output<S>,
): z.ZodCatch<S> => schema.catch(fallback);

import type { z } from "zod";

export const fallingBackTo = <S extends z.ZodType>(
  schema: S,
  fallback: z.output<S>,
): z.ZodCatch<S> => schema.catch(fallback);

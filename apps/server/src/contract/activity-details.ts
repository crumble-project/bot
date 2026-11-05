import { z } from "zod";

// Anything a call sent or a result returned, as text: strings as they are, other values as JSON.
const asText = z.union([
  z.string(),
  z.unknown().transform((value) => JSON.stringify(value) ?? ""),
]);

/** What the feed reads of an activity's `details`, which the response types as an open record; empty when they don't parse. */
export const activityDetails = z
  .object({
    toolName: z.string().optional(),
    name: z.string().optional(),
    content: asText.optional(),
    arguments: asText.optional(),
    args: z.string().optional(),
    isError: z.boolean().optional(),
    error: z.string().optional(),
    communication: z
      .object({
        fromName: z.string().optional(),
        toName: z.string().optional(),
      })
      .optional(),
  })
  .catch({});

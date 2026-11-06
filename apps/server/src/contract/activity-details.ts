import { z } from "zod";

const asText = z.union([
  z.string(),
  z.unknown().transform((value) => JSON.stringify(value) ?? ""),
]);

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

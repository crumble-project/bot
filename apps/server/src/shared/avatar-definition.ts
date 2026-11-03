import { z } from "zod";
import { validateAvatar } from "open-bot-avatar";

/** The canonical bot avatar: portable geometry, body color and eye color. */
export const avatarDefinitionSchema = z.object({
  definition: z
    .strictObject({
      version: z.literal(1),
      id: z.string().min(1).max(40),
      name: z.string().min(1).max(40),
      body: z.strictObject({ path: z.string().trim().min(1).max(6000) }),
      eyes: z.strictObject({
        x: z.number(),
        y: z.number(),
        spacing: z.number(),
        scale: z.number(),
      }),
    })
    .superRefine((definition, ctx) => {
      const result = validateAvatar(definition);

      if (!result.ok)
        for (const message of result.errors)
          ctx.addIssue({ code: "custom", message });
    }),
  color: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use #rgb or #rrggbb"),
  eyeColor: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use #rgb or #rrggbb"),
});

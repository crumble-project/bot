import { z } from "@hono/zod-openapi";
import type { DBFieldAttribute } from "better-auth";

export const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

/** Per-person settings stored as columns on Better Auth's user table and returned with the session. */
export const userPreferenceFields = {
  theme: {
    type: [...THEMES],
    required: false,
    defaultValue: "system",
    input: true,
    validator: { input: z.enum(THEMES) },
  },
} satisfies Record<string, DBFieldAttribute>;

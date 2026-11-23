import { z } from "@hono/zod-openapi";
import type { DBFieldAttribute } from "better-auth";

export const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

export const MAX_PINS = 9;

export const pinKey = z.string().regex(/^agent:\S+$/);

export const pinnedConversations = z
  .array(pinKey)
  .max(MAX_PINS)
  .refine((keys) => new Set(keys).size === keys.length, {
    message: "A conversation is pinned once",
  });

export const userPreferenceFields = {
  theme: {
    type: [...THEMES],
    required: false,
    defaultValue: "system",
    input: true,
    validator: { input: z.enum(THEMES) },
  },
  pinnedConversations: {
    type: "json",
    required: false,
    defaultValue: [],
    input: true,
    validator: { input: pinnedConversations },
    transform: { output: (value) => value ?? [] },
  },
} satisfies Record<string, DBFieldAttribute>;

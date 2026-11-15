import { z } from "@hono/zod-openapi";
import type { DBFieldAttribute } from "better-auth";

export const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

/** Messages allows nine pins: three rows of three. */
export const MAX_PINS = 9;

/** A pinned conversation: `agent:<botId>` or `group:<groupId>`. */
export const pinKey = z.string().regex(/^(agent|group):\S+$/);

/** The pinned conversations in order, first pin first. */
export const pinnedConversations = z
  .array(pinKey)
  .max(MAX_PINS)
  .refine((keys) => new Set(keys).size === keys.length, {
    message: "A conversation is pinned once",
  });

/** Per-person settings stored as columns on Better Auth's user table and returned with the session. */
export const userPreferenceFields = {
  theme: {
    type: [...THEMES],
    required: false,
    defaultValue: "system",
    input: true,
    validator: { input: z.enum(THEMES) },
  },
  pinnedConversations: {
    // Not "string[]": SQLite stores that as TEXT, which Better Auth then reports as a type mismatch
    // on every start. "json" is also TEXT, and comes back as the array.
    type: "json",
    required: false,
    defaultValue: [],
    input: true,
    validator: { input: pinnedConversations },
  },
} satisfies Record<string, DBFieldAttribute>;

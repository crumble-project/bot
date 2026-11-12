import { z } from "zod";
import { avatarDefinitionSchema } from "../shared/avatar-definition";
import {
  DEFAULT_REVIEW_THRESHOLD,
  MAX_BOT_DESCRIPTION_CHARS,
  MAX_BOT_MCP_SERVERS,
  MAX_BOT_NAME_CHARS,
  MAX_BOT_SKILLS,
  MAX_BOT_TOOLS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_TOOL_ID_CHARS,
} from "../shared/limits";
import { WEB_SEARCH_PROVIDER_IDS } from "../shared/vendors";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const providerId = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PROVIDER_ID_CHARS)
  .regex(/^[a-z0-9-]+$/);

const modelId = z.string().trim().min(1).max(MAX_MODEL_ID_CHARS);

const modelRef = z.object({ provider: providerId, model: modelId });

/** A model other than the bot's own; null clears it in a patch. */
const modelChoice = modelRef.nullable().optional();

/** The account's judge model for intent checks; null goes back to the default. */
export const judgeModelInput = z.object({ judgeModel: modelRef.nullable() });

/** The account's vision model, which reads images for bots whose model can't; null turns it off. */
export const visionModelInput = z.object({ visionModel: modelRef.nullable() });

export const DEFAULT_BOT_INSTRUCTIONS =
  "You are a thoughtful, capable personal assistant.";

export const agentInput = z.object({
  name: z.string().trim().min(1).max(MAX_BOT_NAME_CHARS),
  avatar: avatarDefinitionSchema.optional(),
  description: z.string().max(MAX_BOT_DESCRIPTION_CHARS).default(""),
  instructions: z
    .string()
    .max(MAX_INSTRUCTIONS_CHARS)
    .default(DEFAULT_BOT_INSTRUCTIONS),
  provider: providerId.default("openai"),
  model: modelId.default("gpt-4.1"),
  webSearchProvider: z.enum(WEB_SEARCH_PROVIDER_IDS).nullable().optional(),
  enabled: z.boolean().default(true),
  tools: z
    .array(z.string().min(1).max(MAX_TOOL_ID_CHARS))
    .max(MAX_BOT_TOOLS)
    .default(["memory"]),
  /** The bot's own skills by name; the full records live in the skill library. Writing replaces them by name. */
  skills: z
    .array(
      z.object({
        name: z.string().min(1).max(MAX_SKILL_NAME_CHARS),
        instructions: z.string().max(MAX_INSTRUCTIONS_CHARS),
      }),
    )
    .max(MAX_BOT_SKILLS)
    .default([]),
  sharedSkills: z.array(z.uuid()).max(MAX_BOT_SKILLS).optional(),
  /** Ignored: a bot with memory always uses shared memory too. */
  sharedMemory: z.boolean().optional(),
  mcpServers: z.array(z.uuid()).max(MAX_BOT_MCP_SERVERS).default([]),
  /** Ignored: a bot that may message other bots reaches every one of them. */
  delegates: z.array(z.uuid()).max(30).default([]),
  inference: z
    .object({
      thinkingLevel: z.enum(THINKING_LEVELS).default("off"),
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().min(1).max(1000000).optional(),
    })
    .optional(),
  /** How the bot reviews its work afterwards to learn skills and memory. Thresholds count tool-activity rounds. */
  review: z
    .object({
      enabled: z.boolean().default(true),
      skillThreshold: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(DEFAULT_REVIEW_THRESHOLD),
      memoryThreshold: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(DEFAULT_REVIEW_THRESHOLD),
      /** Caps the turn digest a review reads; unset, 75% of the review model's context window, at most 600000. */
      maxInputTokens: z.number().int().min(1000).max(2000000).optional(),
    })
    .optional(),
  /** The model that runs this bot's reviews; unset or null, they use the bot's own model. Null clears it in a patch. */
  reviewModel: modelChoice,
  /** The model for this bot's desktop jobs; unset or null, they use the bot's own model. Null clears it in a patch. */
  desktopModel: modelChoice,
});

export type AgentInput = z.infer<typeof agentInput>;

/** A stored bot: a cleared desktop or review model is absent, never null. */
export type Agent = Omit<
  AgentInput,
  "avatar" | "desktopModel" | "reviewModel"
> & {
  avatar: z.infer<typeof avatarDefinitionSchema>;
  desktopModel?: NonNullable<AgentInput["desktopModel"]>;
  reviewModel?: NonNullable<AgentInput["reviewModel"]>;
  id: string;
  createdAt: string;
  updatedAt: string;
};

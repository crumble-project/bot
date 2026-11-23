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

export const modelRef = z.object({ provider: providerId, model: modelId });

const modelChoice = modelRef.nullable().optional();

export const judgeModelInput = z.object({ judgeModel: modelRef.nullable() });

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
  sharedMemory: z.boolean().optional(),
  mcpServers: z.array(z.uuid()).max(MAX_BOT_MCP_SERVERS).default([]),
  delegates: z.array(z.uuid()).max(30).default([]),
  inference: z
    .object({
      thinkingLevel: z.enum(THINKING_LEVELS).default("off"),
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
    })
    .optional(),
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
      maxInputTokens: z.number().int().min(1000).max(2_000_000).optional(),
    })
    .optional(),
  reviewModel: modelChoice,
  desktopModel: modelChoice,
});

export type AgentInput = z.infer<typeof agentInput>;

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

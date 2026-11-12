import { z } from "@hono/zod-openapi";
import { MAX_MODEL_ID_CHARS, MAX_PROVIDER_ID_CHARS } from "../shared/limits";
import { THINKING_LEVELS } from "./agents";

export const thinkingLevel = z.enum(THINKING_LEVELS);

export const reasoningPreviewInput = z.object({
  provider: z.string().max(MAX_PROVIDER_ID_CHARS),
  model: z.string().max(MAX_MODEL_ID_CHARS),
  thinkingLevel: thinkingLevel.default("off"),
});

export const reasoningOption = z
  .object({
    value: thinkingLevel,
    label: z.string(),
  })
  .openapi("ReasoningOption");

export const reasoningPreviewResponse = z
  .object({
    options: z.array(reasoningOption),
    effectiveLevel: thinkingLevel,
  })
  .openapi("ReasoningPreview");

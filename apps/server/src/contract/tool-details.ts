import { z } from "zod";
import { botRequestResponse } from "./api-responses";
import { parsedChartLayout } from "./chart";
import { webSource } from "./web-search";

const usageTotals = z.looseObject({
  totalTokens: z.number().optional(),
  cost: z.looseObject({ total: z.number().optional() }).optional(),
});

/** Pi Durable's usage document, as far as clients sum its tokens and cost. `tools` holds tool results' own spend, such as vision and intent checks. */
export const usageDocument = z.looseObject({
  models: z.record(z.string(), usageTotals).optional(),
  tools: z.record(z.string(), usageTotals).optional(),
});

export const jobDetails = z.object({
  name: z.string().min(1),
  status: z.string().optional(),
});

export const ownerRequestDetails = z.object({
  name: z.string().min(1),
  hosts: z.array(z.string()).default([]),
  requestedAt: z.string().optional(),
});

export const botRequestDetails = botRequestResponse;

export const reactionDetails = z.object({ emoji: z.string() });

export const webPagesDetails = z.array(
  z.union([webSource, z.object({ url: z.string(), error: z.string() })]),
);

const title = z.string().optional();

export const displayDetails = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stats"),
    title,
    items: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        change: z.string().optional(),
        trend: z.enum(["up", "down", "flat"]).optional(),
        caption: z.string().optional(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("table"),
    title,
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number()]))),
  }),
  z.object({
    kind: z.literal("chart"),
    title,
    layouts: z.array(parsedChartLayout),
  }),
]);

export type DisplayDetails = z.infer<typeof displayDetails>;

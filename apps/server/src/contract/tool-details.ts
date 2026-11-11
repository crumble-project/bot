import { z } from "zod";
import { botRequestResponse } from "./api-responses";
import type { ChartLayout } from "./chart";
import { webSource } from "./web-search";

/** Pi Durable's usage document, as far as clients sum its cost. */
export const usageDocument = z.looseObject({
  models: z
    .record(
      z.string(),
      z.looseObject({
        cost: z.looseObject({ total: z.number().optional() }).optional(),
      }),
    )
    .optional(),
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

/** Compiled layouts are stored parsed, so `chartLayout`, which reads the runtime's output, would reject them. */
const storedLayout = z.custom<ChartLayout>(
  (value) =>
    z
      .object({ nodes: z.array(z.unknown()), points: z.array(z.unknown()) })
      .safeParse(value).success,
);

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
    layouts: z.array(storedLayout),
  }),
]);

export type DisplayDetails = z.infer<typeof displayDetails>;

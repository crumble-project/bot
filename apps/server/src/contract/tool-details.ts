import { z } from "zod";
import { botRequestResponse } from "./api-responses";
import type { ChartLayout } from "./chart";
import { webSource } from "./web-search";

// What tools store as details and blocks. The wire leaves those `unknown`, so these never reach the OpenAPI document.

const optionalText = z.string().optional().catch(undefined);

/** One provider content block of a message: text, or a call with the arguments clients show. */
export const contentBlocks = z.array(
  z.looseObject({
    type: z.string().optional(),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    arguments: z
      .looseObject({ command: optionalText, path: optionalText })
      .optional()
      .catch(undefined),
  }),
);

export type ContentBlock = z.infer<typeof contentBlocks>[number];

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

/** The `coding` and `desktop` tools: the job a call names. */
export const jobDetails = z.object({
  name: z.string().min(1),
  status: z.string().optional(),
});

/** `request_credential` and `request_login`: the saved request. */
export const ownerRequestDetails = z.object({
  name: z.string().min(1),
  hosts: z.array(z.string()).default([]),
  requestedAt: z.string().optional(),
});

/** `request_bot`: the saved request. */
export const botRequestDetails = botRequestResponse;

/** `react`: the emoji it sent. */
export const reactionDetails = z.object({ emoji: z.string() });

/** `web_search` and `web_extract`: each result, or the failure reading a page. */
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

/** `show`: the component to draw. */
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

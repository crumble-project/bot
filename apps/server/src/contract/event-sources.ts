import { z } from "zod";

export const relayUrlInput = z
  .object({
    url: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .nullable(),
  })
  .strict();

export const eventSourceInput = z
  .object({ name: z.string().trim().min(1).max(200) })
  .strict();

export const relayStatusResponse = z.object({
  url: z.string().nullable(),
  tokenConfigured: z.boolean(),
  status: z.enum(["disconnected", "connecting", "connected", "error"]),
  error: z.string().nullable(),
});

export const eventSourceResponse = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  usedBy: z.number().int().nonnegative(),
});

export const eventSourcesResponse = z.object({
  sources: z.array(eventSourceResponse),
});

export const createdEventSourceResponse = eventSourceResponse.extend({
  address: z.string(),
});

export type RelayStatusResponse = z.infer<typeof relayStatusResponse>;

export type EventSourceResponse = z.infer<typeof eventSourceResponse>;

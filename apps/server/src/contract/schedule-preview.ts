import { z } from "@hono/zod-openapi";
import {
  MAX_CRON_CHARS,
  MAX_EVENT_SOURCE_ID_CHARS,
  MAX_TIMEZONE_CHARS,
} from "../shared/limits";

export const schedulePreviewInput = z.object({
  cron: z.string().max(MAX_CRON_CHARS).nullable().optional(),
  runAt: z.iso.datetime({ offset: true }).nullable().optional(),
  eventSourceId: z
    .string()
    .max(MAX_EVENT_SOURCE_ID_CHARS)
    .nullable()
    .optional(),
  timezone: z.string().max(MAX_TIMEZONE_CHARS),
});

export const schedulePreviewResponse = z
  .object({
    description: z.string(),
    text: z.string(),
    isProblem: z.boolean(),
    nextRunAt: z.string().nullable(),
  })
  .openapi("SchedulePreview");

export type SchedulePreviewInput = z.infer<typeof schedulePreviewInput>;

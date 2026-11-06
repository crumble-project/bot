import { z } from "zod";
import {
  DEFAULT_SCHEDULE_TIMEOUT_SECONDS,
  DEFAULT_SCHEDULE_TIMEZONE,
  MAX_CRON_CHARS,
  MAX_EVENT_SOURCE_ID_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_SCHEDULE_COMMAND_CHARS,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULE_TIMEOUT_SECONDS,
  MAX_TIMEZONE_CHARS,
} from "../shared/limits";

export const SCHEDULE_TRIGGER_MESSAGE =
  "Choose a recurring cron, a one-time date, or an event source";

export const SCHEDULE_KINDS = ["prompt", "script"] as const;

export const scheduleInput = z
  .object({
    agentId: z.uuid(),
    name: z.string().trim().min(1).max(MAX_SCHEDULE_NAME_CHARS),
    kind: z.enum(SCHEDULE_KINDS).default("prompt"),
    prompt: z.string().trim().max(MAX_MESSAGE_CHARS).default(""),
    command: z
      .string()
      .max(MAX_SCHEDULE_COMMAND_CHARS)
      .nullable()
      .default(null),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_SCHEDULE_TIMEOUT_SECONDS)
      .default(DEFAULT_SCHEDULE_TIMEOUT_SECONDS),
    notify: z.boolean().default(true),
    cron: z.string().max(MAX_CRON_CHARS).nullable().default(null),
    timezone: z
      .string()
      .max(MAX_TIMEZONE_CHARS)
      .default(DEFAULT_SCHEDULE_TIMEZONE),
    runAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .nullable()
      .default(null),
    eventSourceId: z
      .string()
      .trim()
      .min(1)
      .max(MAX_EVENT_SOURCE_ID_CHARS)
      .nullable()
      .default(null),
    enabled: z.boolean().default(true),
  })
  .refine(
    (v) => [v.cron, v.runAt, v.eventSourceId].filter(Boolean).length === 1,
    SCHEDULE_TRIGGER_MESSAGE,
  )
  .refine(
    (v) =>
      v.kind === "prompt"
        ? v.prompt.length > 0 && v.command === null
        : Boolean(v.command?.trim()),
    "Prompt tasks need a prompt and no command; script tasks need a command",
  );

export type ScheduleInput = z.infer<typeof scheduleInput>;

export type Schedule = ScheduleInput & {
  id: string;
  nextRunAt: string | null;
  createdAt: string;
  /** The bot that saved this task, or null when the owner saved it. */
  createdByAgentId: string | null;
};

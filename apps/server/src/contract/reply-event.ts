import { z } from "@hono/zod-openapi";
import { WAITING_FOR } from "../shared/domain";

export const REPLY_ORIGIN = {
  bot: "bot",
} as const;

export const replyEvent = z
  .object({
    type: z.literal("reply"),
    eventId: z.string(),
    serverId: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    entryId: z.string().nullable(),
    origin: z.string().openapi({
      description:
        "What the bot answered: owner (a message from the owner), task (a scheduled task), script (a script task's result), bot (another bot's request), or coding or desktop (a job's report; jobName names the job). Clients may receive other values later.",
    }),
    preview: z.string(),
    createdAt: z.string(),
    executionId: z.string().optional(),
    jobName: z.string().optional().openapi({
      description:
        "The job whose report the bot answered, for origin coding or desktop. A desktop job's report often asks for the owner; clients may open the bot desktop.",
    }),
    waitingFor: z.enum(WAITING_FOR).optional().openapi({
      description:
        "Set when the bot waits for the owner's answer: approval (a desktop job action held by an intent check, or a call request), credential, or login (a request the owner saves or declines). Clients may receive other values later.",
    }),
  })
  .openapi("ReplyEvent");

export type ReplyEvent = z.infer<typeof replyEvent>;

export type WaitingFor = (typeof WAITING_FOR)[number];

export type ReplyActivity = {
  type: "reply";
  executionId: string;
  agentId: string;
  agentName: string;
  entryId: string | null;
  origin: string;
  preview: string;
  createdAt: string;
  jobName?: string;
  waitingFor?: WaitingFor;
};

export function canonicalReplyEvent(
  activity: Omit<ReplyActivity, "type">,
  serverId: string,
): ReplyEvent {
  return {
    ...(activity.jobName && { jobName: activity.jobName }),
    ...(activity.waitingFor && { waitingFor: activity.waitingFor }),
    type: "reply",
    eventId: activity.executionId,
    serverId,
    agentId: activity.agentId,
    agentName: activity.agentName,
    entryId: activity.entryId,
    origin: activity.origin,
    preview: activity.preview,
    createdAt: activity.createdAt,
  };
}

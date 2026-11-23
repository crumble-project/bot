import type { EntryRecord } from "@earendil-works/pi-durable";
import { z } from "zod";
import { botCommunication } from "../contract/api-responses";
import { ATTACHMENT_KINDS } from "../shared/attachment-rules";
import { fallingBackTo } from "../shared/fallback-schema";

export const MESSAGE_ENTRY = "crumble.message";

export const BOT_MESSAGE_ENTRY = "crumble.bot-message";

export const JOB_QUESTION_ENTRY = "crumble.job-question";

export const HELD_ACTION_ENTRY = "crumble.held-action";

export const CALL_ENTRY = "crumble.voice-call";
export const ASSISTANT_ENTRY = "pi.assistant";
export const USER_ENTRY = "pi.user";

export type ModelContent = NonNullable<EntryRecord["model"]>[number]["content"];

export type MessageOrigin = {
  kind: string;
  name?: string;
  agentId?: string;
  via?: string;
  source?: string;
};

export const messageOrigin = z
  .object({
    kind: z.string(),
    name: fallingBackTo(z.string().optional(), undefined),
    agentId: fallingBackTo(z.string().optional(), undefined),
    via: fallingBackTo(z.string().optional(), undefined),
    source: fallingBackTo(z.string().optional(), undefined),
  })
  .transform(({ kind, name, agentId, via, source }) => {
    const origin: MessageOrigin = { kind };

    if (name !== undefined) {
      origin.name = name;
    }

    if (agentId !== undefined) {
      origin.agentId = agentId;
    }

    if (via !== undefined) {
      origin.via = via;
    }

    if (source !== undefined) {
      origin.source = source;
    }

    return origin;
  });

export const attachmentInfo = z.object({
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  kind: z.enum(ATTACHMENT_KINDS),
});

export const jobQuestionData = z.object({
  id: z.string(),
  kind: z.string(),
  job: z.string(),
  text: z.string(),
  timestamp: z.number(),
  options: z.array(z.string()).optional(),
  multiple: z.boolean().optional(),
});

export const heldActionData = z.object({
  id: z.string(),
  job: z.string(),
  action: z.string(),
  timestamp: fallingBackTo(z.number().optional(), undefined),
});

export const CALL_DIRECTIONS = ["inbound", "outbound"] as const;

/** `greeting`: what the bot said on a call it placed. `text`: an ended call's line. `callee`: whom an outside call reached. */
export const callEventData = z.object({
  callId: z.string(),
  phase: z.enum(["started", "ended"]),
  direction: z.enum(CALL_DIRECTIONS),
  callee: z.string().exactOptional(),
  greeting: z.string().exactOptional(),
  text: z.string().exactOptional(),
  timestamp: z.number(),
});

export type CallEventData = Omit<z.infer<typeof callEventData>, "timestamp">;

export const botMessage = z.object({
  content: z.string(),
  timestamp: fallingBackTo(z.number().optional(), undefined),
  communication: botCommunication,
});

export const messageFile = z.union([
  z.object({
    id: z.string(),
    name: z.string(),
    mimeType: z.string(),
    size: z.number(),
  }),
  z.object({ id: z.string(), deleted: z.literal(true) }),
]);

export const inputMetadata = z.object({
  text: fallingBackTo(z.string().optional(), undefined),
  replyTo: fallingBackTo(z.string().optional(), undefined),
  requestId: fallingBackTo(z.string().optional(), undefined),
  replyPreview: fallingBackTo(z.string().optional(), undefined),
});

export function contentText(content: ModelContent | undefined): string {
  if (!Array.isArray(content)) {
    return content ?? "";
  }

  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

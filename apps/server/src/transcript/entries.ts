import type { EntryRecord } from "@earendil-works/pi-durable";
import { z } from "zod";
import { botCommunication } from "../contract/api-responses";
import { webSource } from "../contract/web-search";
import { ATTACHMENT_KINDS, attachmentInput } from "../shared/attachment-rules";

/** An input Crumble admitted: the owner's, an automation's, a notice, or a job's report. */
export const MESSAGE_ENTRY = "crumble.message";

/** A message between two bots, shown in a chat without starting a turn. */
export const BOT_MESSAGE_ENTRY = "crumble.bot-message";
export const GROUP_MESSAGE_ENTRY = "crumble.group-message";

/** The bot chat entry that shows a job's question to the owner, without a turn of the bot. */
export const JOB_QUESTION_ENTRY = "crumble.job-question";

/** The bot chat entry that shows a desktop job's held action to the owner. */
export const HELD_ACTION_ENTRY = "crumble.held-action";
export const ASSISTANT_ENTRY = "pi.assistant";
export const USER_ENTRY = "pi.user";

export type ModelContent = NonNullable<EntryRecord["model"]>[number]["content"];

export type MessageOrigin = {
  kind: string;
  name?: string;
  agentId?: string;
  /** The message gateway an owner message arrived through, such as `discord`. */
  via?: string;
  /** The event source whose event started an event automation's message. */
  source?: string;
};

// Drops an unreadable name or agent ID instead of keeping it as `undefined`, so origins stay JSON.
export const messageOrigin = z
  .object({
    kind: z.string(),
    name: z.string().optional().catch(undefined),
    agentId: z.string().optional().catch(undefined),
    via: z.string().optional().catch(undefined),
    source: z.string().optional().catch(undefined),
  })
  .transform(({ kind, name, agentId, via, source }) => {
    const origin: MessageOrigin = { kind };

    if (name !== undefined) origin.name = name;

    if (agentId !== undefined) origin.agentId = agentId;

    if (via !== undefined) origin.via = via;

    if (source !== undefined) origin.source = source;

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
  timestamp: z.number().optional().catch(undefined),
});

export const botMessage = z.object({
  content: z.string(),
  timestamp: z.number().optional().catch(undefined),
  communication: botCommunication,
});

/** A group chat message: the owner's or a bot's words, or a bot's reaction, written once under its request ID. */
export const groupMessageData = z.object({
  text: z.string(),
  sender: messageOrigin,
  requestId: z.string(),
  timestamp: z.number(),
  replyTo: z.string().exactOptional(),
  replyPreview: z.string().exactOptional(),
  /** The emoji of a reaction to `replyTo`; a reaction has no text. */
  reaction: z.string().exactOptional(),
  /** The owner's uploads, kept with the message so every member turn can include them. */
  attachments: z.array(attachmentInput).exactOptional(),
  /** What pages show for each upload, without its bytes. */
  files: z.array(attachmentInfo).exactOptional(),
  /** Pages the bot's turn searched or read, which the message may cite. */
  sources: z.array(webSource).exactOptional(),
});

export type GroupMessageData = z.infer<typeof groupMessageData>;

export const inputMetadata = z.object({
  text: z.string().optional().catch(undefined),
  replyTo: z.string().optional().catch(undefined),
  requestId: z.string().optional().catch(undefined),
  replyPreview: z.string().optional().catch(undefined),
});

/** The text blocks of model content, one per line. */
export function contentText(content: ModelContent | undefined): string {
  if (!Array.isArray(content)) return content ?? "";

  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

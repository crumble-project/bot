import { Schema } from "effect";

export type PushPlatform = "macos" | "ios" | "android";

export type PushTransportName = "apns" | "fcm";

export type PushDeviceInput = {
  platform: PushPlatform;
  transport: PushTransportName;
  token: string;
  environment: "development" | "production";
  bundleId?: string | undefined;
  enabled: boolean;
};

export type PushDevice = PushDeviceInput & {
  installationId: string;
  updatedAt: string;
};

/** A finished reply as push transports send it; the outbox stores it as JSON. */
export const ReplyPushEvent = Schema.Struct({
  type: Schema.Literal("reply"),
  eventId: Schema.String,
  serverId: Schema.String,
  agentId: Schema.String,
  agentName: Schema.String,
  entryId: Schema.NullOr(Schema.String),
  origin: Schema.String,
  preview: Schema.String,
  createdAt: Schema.String,
  /** Present for a bot's answer in a group chat. */
  groupId: Schema.optionalKey(Schema.String),
  groupName: Schema.optionalKey(Schema.String),
  /** Present for a bot's answer to a coding or desktop job's report. */
  jobName: Schema.optionalKey(Schema.String),
});

export type ReplyPushEvent = typeof ReplyPushEvent.Type;

/** The notification title: the bot, and the group when the answer came from one. */
export const notificationTitle = (event: ReplyPushEvent) =>
  event.groupName
    ? `${event.agentName} in ${event.groupName}`
    : event.agentName;

export function canonicalReplyEvent(
  event: {
    executionId?: string;
    eventId?: string;
    serverId?: string;
    agentId: string;
    agentName: string;
    entryId?: string | null;
    origin: string;
    preview: string;
    createdAt: string;
    groupId?: string;
    groupName?: string;
    jobName?: string;
  },
  serverId: string,
): ReplyPushEvent {
  return {
    ...(event.groupId && { groupId: event.groupId }),
    ...(event.groupName && { groupName: event.groupName }),
    ...(event.jobName && { jobName: event.jobName }),
    type: "reply",
    eventId: event.eventId ?? event.executionId!,
    serverId: event.serverId ?? serverId,
    agentId: event.agentId,
    agentName: event.agentName,
    entryId: event.entryId ?? null,
    origin: event.origin,
    preview: event.preview,
    createdAt: event.createdAt,
  };
}

export function notificationPreview(value: string) {
  const cleaned = value
    .replace(/\*\*|__|`|^\s*[#>]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return cleaned || "Replied";
}

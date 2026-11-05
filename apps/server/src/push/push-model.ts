import type { ReplyEvent } from "../contract/reply-event";

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

/** The notification title: the bot, and the group when the answer came from one. */
export const notificationTitle = (event: ReplyEvent) =>
  event.groupName
    ? `${event.agentName} in ${event.groupName}`
    : event.agentName;

export function notificationPreview(value: string) {
  const cleaned = value
    .replace(/\*\*|__|`|^\s*[#>]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return cleaned || "Replied";
}

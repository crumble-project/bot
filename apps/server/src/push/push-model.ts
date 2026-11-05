import type { z } from "@hono/zod-openapi";
import type { pushInput } from "../contract/push";
import type { ReplyEvent } from "../contract/reply-event";

export type PushDeviceInput = z.output<typeof pushInput>;

export type PushTransportName = PushDeviceInput["transport"];

export type PushDevice = PushDeviceInput & {
  installationId: string;
  updatedAt: string;
};

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

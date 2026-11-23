import type { SSEStreamingApi } from "hono/streaming";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { streamEvents } from "../shared/event-stream";
import { canonicalReplyEvent } from "../contract/reply-event";
import type { Activity, BotsAccess } from "./bots";

function activityFrame(data: Activity, serverId: string) {
  switch (data.type) {
    case "reply":
      return { event: "activity", data: canonicalReplyEvent(data, serverId) };
    case "learned":
      return { event: "learned", data };
    case "pins":
      return {
        event: "pins",
        data: { pinnedConversations: data.pinnedConversations },
      };
    case "chat-preview":
      return { event: "activity", data };
  }
}

const activitySender =
  (serverId: string, stream: SSEStreamingApi, close: () => void) =>
  (activity: Activity) => {
    const { event, data } = activityFrame(activity, serverId);

    if (!stream.aborted) {
      stream.writeSSE({ event, data: JSON.stringify(data) }).catch(close);
    }
  };

export function registerBotActivityRoutes(options: {
  register: Register;
  service: BotsAccess;
  serverId: string;
}) {
  const { register, service, serverId } = options;

  register.plain(routes.events, (c) =>
    streamEvents(c, async ({ stream, close, onClose }) => {
      const send = activitySender(serverId, stream, close);

      const sentStatuses = new Map<string, string>();

      const sendStatus = (event: { agentId: string; status: string }) => {
        if (
          sentStatuses.get(event.agentId) !== event.status &&
          !stream.aborted
        ) {
          sentStatuses.set(event.agentId, event.status);
          stream
            .writeSSE({ event: "bot-status", data: JSON.stringify(event) })
            .catch(close);
        }
      };

      onClose(service.onActivity(send));
      onClose(service.onBotStatus(sendStatus));

      for (const { agent, lastMessage } of await service.agentPreviews()) {
        send({
          type: "chat-preview",
          agentId: agent.id,
          agentName: agent.name,
          lastMessage,
        });
      }

      await service.requestStatuses();
    }),
  );
}

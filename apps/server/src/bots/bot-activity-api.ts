import type { SSEStreamingApi } from "hono/streaming";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { streamEvents } from "../shared/event-stream";
import { canonicalReplyEvent } from "../contract/reply-event";
import type { Activity, BotsAccess } from "./bots";

/** The SSE event an activity is sent as, and its data. Learned and pins events are their own event names. */
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

/** Writes one activity as the event the clients expect, canonicalized so replies match the push payload. */
const activitySender =
  (serverId: string, stream: SSEStreamingApi, close: () => void) =>
  (activity: Activity) => {
    const { event, data } = activityFrame(activity, serverId);

    if (!stream.aborted)
      stream.writeSSE({ event, data: JSON.stringify(data) }).catch(close);
  };

export function registerBotActivityRoutes(options: {
  register: Register;
  service: BotsAccess;
  /** The ID clients match replies against notifications with; a runner without push has none. */
  serverId: string;
}) {
  const { register, service, serverId } = options;

  register.plain(routes.events, (c) =>
    streamEvents(c, async ({ stream, close, onClose }) => {
      const send = activitySender(serverId, stream, close);

      onClose(service.onActivity(send));

      // Replay current previews on every connection so a sidebar can recover missed events.
      for (const { agent, lastMessage } of await service.agentPreviews())
        send({
          type: "chat-preview",
          agentId: agent.id,
          agentName: agent.name,
          lastMessage,
        });
    }),
  );
}

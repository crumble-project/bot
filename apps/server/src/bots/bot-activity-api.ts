import type { SSEStreamingApi } from "hono/streaming";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { sendHeartbeat, streamEvents } from "../shared/event-stream";
import { canonicalReplyEvent } from "../contract/reply-event";
import type { Activity, BotsAccess } from "./bots";

/** Writes one activity as the event the clients expect, canonicalized so replies match the push payload. */
const activitySender =
  (serverId: string, stream: SSEStreamingApi, close: () => void) =>
  (data: Activity) => {
    const canonical =
      data.type === "reply" ? canonicalReplyEvent(data, serverId) : data;

    if (!stream.aborted)
      stream
        .writeSSE({
          event: data.type === "learned" ? "learned" : "activity",
          data: JSON.stringify(canonical),
        })
        .catch(close);
  };

/** Server-wide activity for notifications: finished replies from every bot. */
export function registerBotActivityRoutes(options: {
  register: Register;
  service: BotsAccess;
  /** The ID clients match replies against notifications with; a runner without push has none. */
  serverId: string;
}) {
  const { register, service, serverId } = options;

  register(routes.events, (c) =>
    streamEvents(c, async ({ stream, close, onClose }) => {
      const send = activitySender(serverId, stream, close);

      onClose(service.onActivity(send));

      // Without bots to preview, the first activity could take 15 seconds to arrive.
      await sendHeartbeat(stream);

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

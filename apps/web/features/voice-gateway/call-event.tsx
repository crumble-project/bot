import { CallMarker } from "@/features/chat/transcript";
import { messageCard } from "@/features/chat/message-card";

export const callEvent = messageCard(
  ({ kind, call, content }) =>
    (kind === "call-started" || kind === "call-ended") && call
      ? {
          ended: kind === "call-ended",
          outbound: call.direction === "outbound",
          content,
        }
      : null,
  ({ result, chat }) =>
    result.ended ? (
      <CallMarker title={result.content} />
    ) : result.outbound ? (
      <CallMarker title={`${chat.botName} called you`} quote={result.content} />
    ) : (
      <CallMarker title="Call started" />
    ),
);

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
  ({ result, chat }) => {
    if (result.ended) return <CallMarker title={result.content} />;

    if (result.outbound)
      return (
        <CallMarker
          title={`${chat.botName} called you`}
          quote={result.content}
        />
      );

    return <CallMarker title="Call started" />;
  },
);

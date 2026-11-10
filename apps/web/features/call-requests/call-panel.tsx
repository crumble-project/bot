import { useQuery } from "@tanstack/react-query";
import { IconPhone, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { hasText } from "@/features/chat/transcript";
import { cn } from "@/lib/utils";
import {
  type CallRequest,
  callRequestsQuery,
  callStateOf,
  callTranscriptQuery,
} from "./api";

function CallPanelHeader({
  request,
  onClose,
}: {
  request: CallRequest | undefined;
  onClose: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
      <IconPhone className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-heading font-semibold leading-tight">
          {request?.callee ?? "Call"}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {request?.number}
        </span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {request && (
          <span className="mr-1 text-xs text-muted-foreground">
            {callStateOf(request)}
          </span>
        )}
        <Button variant="ghost" size="icon-sm" title="Close" onClick={onClose}>
          <IconX />
        </Button>
      </div>
    </header>
  );
}

function Line({
  speaker,
  mine,
  children,
}: {
  speaker: string;
  mine: boolean;
  children: string;
}) {
  return (
    <li className={cn("flex flex-col gap-0.5", mine && "items-end")}>
      <span className="text-xs text-muted-foreground">{speaker}</span>
      <p
        className={cn(
          "max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap",
          mine ? "bg-muted" : "border",
        )}
      >
        {children}
      </p>
    </li>
  );
}

function CallLines({
  request,
  botId,
  botName,
}: {
  request: CallRequest;
  botId: string;
  botName: string;
}) {
  const calling = request.status === "calling";

  const transcript = useQuery(callTranscriptQuery(botId, request.id, calling));

  const lines = (transcript.data?.messages ?? []).filter(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" && hasText(message)),
  );

  return (
    <ul className="flex flex-col gap-3">
      <Line speaker={botName} mine>
        {request.opening}
      </Line>
      {lines.map((message) => (
        <Line
          key={message.id}
          speaker={message.role === "user" ? request.callee : botName}
          mine={message.role !== "user"}
        >
          {message.content}
        </Line>
      ))}
      {transcript.isPending && <Spinner className="mx-auto" />}
      {transcript.isError && (
        <li className="text-sm text-muted-foreground">
          Couldn't load the transcript.
        </li>
      )}
      {transcript.isSuccess && !lines.length && !calling && (
        <li className="text-sm text-muted-foreground">No transcript.</li>
      )}
      {calling && <li className="shimmer text-sm">On the call…</li>}
    </ul>
  );
}

/** A call request's call beside the chat: its goal, then what was said, live while it goes on. */
export function CallPanel({
  botId,
  botName,
  requestId,
  onClose,
}: {
  botId: string;
  botName: string;
  requestId: string;
  onClose: () => void;
}) {
  const requests = useQuery(callRequestsQuery(botId));
  const request = requests.data?.find((item) => item.id === requestId);

  return (
    <aside
      aria-label={request?.callee ?? "Call"}
      className="flex min-h-0 flex-col border-l bg-background max-lg:fixed max-lg:inset-0 max-lg:z-40 lg:w-[min(42rem,50%)] lg:shrink-0"
    >
      <CallPanelHeader request={request} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {requests.isPending && <Spinner className="mx-auto" />}
        {request && (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Goal</span>
              <p className="text-sm whitespace-pre-wrap">{request.goal}</p>
            </div>
            {request.outcome === "failed" && request.error && (
              <p className="text-sm text-destructive">{request.error}</p>
            )}
            <CallLines request={request} botId={botId} botName={botName} />
          </>
        )}
      </div>
    </aside>
  );
}

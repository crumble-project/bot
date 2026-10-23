import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpIcon, PencilIcon, SquareIcon, WrenchIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  type ChatSnapshot,
  botsQuery,
  chatQuery,
  followChat,
  send,
} from "./api";
import { Reply } from "./markdown";

type Message = ChatSnapshot["messages"][number];

export function Chat({ botId }: { botId: string }) {
  const chat = useQuery(chatQuery(botId));
  const bot = useQuery(botsQuery).data?.find((each) => each.id === botId);
  const [draft, setDraft] = useState("");
  const path = `/v1/agents/${encodeURIComponent(botId)}`;

  useEffect(() => {
    const controller = new AbortController();
    void followChat(botId, controller.signal);

    return () => controller.abort();
  }, [botId]);

  const message = useMutation({
    mutationFn: (content: string) =>
      send(`${path}/messages`, "POST", {
        content,
        requestId: crypto.randomUUID(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    onSuccess: () => setDraft(""),
  });

  const stop = useMutation({ mutationFn: () => send(`${path}/abort`, "POST") });

  if (chat.isPending)
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        <Skeleton className="h-10 w-1/2 self-end" />
        <Skeleton className="h-20 w-3/4" />
      </div>
    );

  if (chat.isError)
    return (
      <Alert variant="destructive" className="m-6 w-auto">
        <AlertDescription>{chat.error.message}</AlertDescription>
      </Alert>
    );

  const { messages, partial, status, error } = chat.data;
  const running = status === "running";
  const failure = error ?? message.error?.message;

  const submit = () => {
    if (draft.trim() && !message.isPending) message.mutate(draft);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <span className="font-medium">{bot?.name}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Edit bot"
          render={<Link to="/bots/$botId/edit" params={{ botId }} />}
          nativeButton={false}
        >
          <PencilIcon />
        </Button>
      </header>
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl p-6">
              {messages.map((entry) => (
                <MessageScrollerItem
                  key={entry.id}
                  messageId={entry.id}
                  scrollAnchor={entry.role === "user"}
                >
                  <Entry message={entry} />
                </MessageScrollerItem>
              ))}
              {running && (
                <MessageScrollerItem messageId="partial">
                  <Message>
                    <MessageContent>
                      <Bubble variant="ghost">
                        {partial ? (
                          <BubbleContent>
                            <Reply source={partial} streaming />
                          </BubbleContent>
                        ) : (
                          <BubbleContent className="shimmer">
                            Thinking…
                          </BubbleContent>
                        )}
                      </Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <form
        className="mx-auto flex w-full max-w-3xl flex-col gap-2 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            aria-label="Message"
            placeholder="Message"
            className="max-h-[40vh] min-h-10 resize-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {running ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              title="Stop"
              onClick={() => stop.mutate()}
            >
              <SquareIcon />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              title="Send"
              disabled={!draft.trim() || message.isPending}
            >
              <ArrowUpIcon />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function Entry({ message }: { message: Message }) {
  if (message.role === "toolResult")
    return (
      <Marker>
        <MarkerIcon>
          <WrenchIcon />
        </MarkerIcon>
        <MarkerContent
          className={message.isError ? "text-destructive" : undefined}
        >
          {message.toolName ?? "tool"}
        </MarkerContent>
      </Marker>
    );

  if (!message.content.trim()) return null;

  if (message.role === "event")
    return (
      <Marker variant="separator">
        <MarkerContent>{message.content}</MarkerContent>
      </Marker>
    );

  const mine = message.role === "user";

  return (
    <Message align={mine ? "end" : "start"}>
      <MessageContent>
        {mine && message.origin?.name && (
          <MessageHeader>{message.origin.name}</MessageHeader>
        )}
        <Bubble
          variant={mine ? "secondary" : "ghost"}
          align={mine ? "end" : "start"}
        >
          {mine ? (
            <BubbleContent className="whitespace-pre-wrap">
              {message.content}
            </BubbleContent>
          ) : (
            <BubbleContent>
              <Reply source={message.content} />
            </BubbleContent>
          )}
        </Bubble>
      </MessageContent>
    </Message>
  );
}

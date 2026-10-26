import { type ReactNode, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import { randomId } from "@/lib/utils";
import { type HistoryPage, type Message, api } from "@/lib/api";
import { deliver } from "./delivery";
import {
  OwnerMessage,
  TimeMarker,
  type Upload,
  mergeMessages,
  withTimeMarkers,
} from "./transcript";

export function useHistory(
  path: string,
  remember: (messages: Message[]) => void,
) {
  const [older, setOlder] = useState<HistoryPage | null>(null);

  const loadEarlier = useMutation({
    mutationFn: (before: string) =>
      api<HistoryPage>(
        `${path}?before=${encodeURIComponent(before)}&limit=100`,
      ),
    onSuccess: (page) => {
      remember(page.messages);
      setOlder({
        messages: mergeMessages(page.messages, older?.messages ?? []),
        hasMore: page.hasMore,
        oldestEntryId: page.oldestEntryId,
      });
    },
  });

  return { older, loadEarlier };
}

export function ConversationError({ error }: { error: Error }) {
  return (
    <Alert variant="destructive" className="m-6 w-auto">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

export function ConversationLoading({
  notFound = false,
}: {
  notFound?: boolean;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      {notFound ? (
        <p className="text-muted-foreground">Bot not found.</p>
      ) : (
        <>
          <Skeleton className="h-10 w-1/2 self-end" />
          <Skeleton className="h-20 w-3/4" />
        </>
      )}
    </div>
  );
}

export function ConversationScroller({ children }: { children: ReactNode }) {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl justify-end gap-3 p-6">
            {children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

export function LoadEarlier({
  pending,
  onLoad,
}: {
  pending: boolean;
  onLoad: () => void;
}) {
  return (
    <MessageScrollerItem messageId="earlier">
      <Button
        variant="ghost"
        size="sm"
        className="mx-auto flex"
        disabled={pending}
        onClick={onLoad}
      >
        Load earlier messages
      </Button>
    </MessageScrollerItem>
  );
}

export function ConversationEmpty({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <MessageScrollerItem messageId="empty">
      <Empty>
        <EmptyHeader>
          <EmptyTitle className="text-lg">{title}</EmptyTitle>
          <EmptyDescription>{children}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </MessageScrollerItem>
  );
}

export function quoteOf(message: Message, byEntry: Map<string, Message>) {
  return (
    message.replyPreview ??
    (message.replyTo ? byEntry.get(message.replyTo)?.content : undefined)
  );
}

export function ConversationRows({
  messages,
  arrival,
  byEntry,
  reactions,
  onReply,
  attachmentPath,
  renderMessage,
}: {
  messages: Message[];
  arrival: (message: Message) => string | undefined;
  byEntry: Map<string, Message>;
  reactions: Map<string, string[]>;
  onReply: (message: Message) => void;
  attachmentPath: (entryId: string, index: number) => string;
  renderMessage: (message: Message) => ReactNode;
}) {
  return withTimeMarkers(messages).map((row) =>
    row.kind === "time" ? (
      <MessageScrollerItem key={row.key} messageId={row.key}>
        <TimeMarker label={row.label} />
      </MessageScrollerItem>
    ) : (
      <MessageScrollerItem
        key={row.message.id}
        messageId={row.message.id}
        className={arrival(row.message)}
      >
        {row.message.role === "user" ? (
          <OwnerMessage
            message={row.message}
            quote={quoteOf(row.message, byEntry)}
            reactions={reactions.get(row.message.entryId)}
            onReply={onReply}
            attachmentPath={attachmentPath}
          />
        ) : (
          renderMessage(row.message)
        )}
      </MessageScrollerItem>
    ),
  );
}

export function useMessageSending(
  chat: string,
  path: string,
  extra?: () => { timezone: string },
) {
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const sendMessage = async (
    content: string,
    uploads: Upload[],
    requestId: string = randomId(),
    target = replyTo?.entryId,
  ) => {
    setReplyTo(null);
    setSendError(null);

    const failure = await deliver(
      chat,
      `${path}/messages`,
      {
        requestId,
        content,
        uploads,
        ...(target && { replyTo: target }),
      },
      extra?.(),
    );

    if (failure) setSendError(`Message was not confirmed: ${failure}`);

    return failure === null;
  };

  return { replyTo, setReplyTo, sendError, sendMessage };
}

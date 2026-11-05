import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import { type HistoryPage, type Message, historyPage } from "./api";
import { api, type RoutePath } from "@/lib/api";
import { useChatStream } from "./chat-stream";
import type { Upload } from "./composer";
import type { ConversationTarget, HistoryRoute } from "./conversation-target";
import {
  type Outgoing,
  confirm,
  deliver,
  outgoingMessage,
  useOutgoing,
} from "./delivery";
import {
  ARRIVAL,
  NoticeRow,
  OwnerMessage,
  type Reaction,
  TimeMarker,
  isNotice,
  mergeMessages,
  reactionsOf,
  useArrivals,
  withTimeMarkers,
} from "./transcript";

function useHistory(
  path: RoutePath<HistoryRoute>,
  remember: (messages: Message[]) => void,
) {
  const [older, setOlder] = useState<HistoryPage | null>(null);

  // A read kept in local state: pages merge into `older`, not a query cache.
  // react-doctor-disable-next-line query-mutation-missing-invalidation
  const loadEarlier = useMutation({
    mutationFn: (before: string) =>
      api<HistoryRoute>(historyPage(path, 100, before)),
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

function useMessageSending<S extends HistoryPage>(
  target: ConversationTarget<S>,
) {
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const sendMessage = async (
    content: string,
    uploads: Upload[],
    requestId: string = randomId(),
    reply = replyTo?.entryId,
  ) => {
    setReplyTo(null);
    setSendError(null);

    const failure = await deliver(
      target.key,
      `${target.path}/messages`,
      {
        requestId,
        content,
        uploads,
        ...(reply && { replyTo: reply }),
      },
      target.sendContext(),
    );

    if (failure) setSendError(`Message was not confirmed: ${failure}`);

    return failure === null;
  };

  return { replyTo, setReplyTo, sendError, sendMessage };
}

export function useConversation<S extends HistoryPage>(
  target: ConversationTarget<S>,
) {
  const navigate = useNavigate();
  const snapshot = useQuery(target.query);
  const outgoing = useOutgoing(target.key);
  const sending = useMessageSending(target);

  const leave = useCallback(() => void navigate({ to: "/" }), [navigate]);

  useChatStream(target, leave);

  const live = snapshot.data?.messages;
  const { arrival, remember } = useArrivals(live);
  const { older, loadEarlier } = useHistory(target.history, remember);

  useEffect(() => {
    if (live)
      confirm(
        target.key,
        new Set(live.flatMap((message) => message.requestId ?? [])),
      );
  }, [target, live]);

  // The live transcript reports the stopped turn.
  // react-doctor-disable-next-line query-mutation-missing-invalidation
  const stop = useMutation({ mutationFn: target.stop });

  const messages = mergeMessages(older?.messages ?? [], live ?? []);
  const page = older ?? snapshot.data;

  return {
    snapshot,
    outgoing,
    sending,
    stop,
    messages,
    arrival,
    loadEarlier,
    hasMore: page?.hasMore,
    oldest: page?.oldestEntryId,
    shown: messages.filter(target.shown),
    reactions: reactionsOf(messages, target.reactionTarget),
    byEntry: new Map(messages.map((message) => [message.entryId, message])),
    attachmentPath: (entryId: string, index: number) =>
      `${target.path}/attachments/${encodeURIComponent(entryId)}/${index}`,
  };
}

export type Conversation = Omit<ReturnType<typeof useConversation>, "snapshot">;

export function ConversationError({ error }: { error: Error }) {
  return (
    <Alert variant="destructive" className="m-6 w-auto">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

export function ConversationLoading() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <Skeleton className="h-10 w-1/2 self-end" />
      <Skeleton className="h-20 w-3/4" />
    </div>
  );
}

export function ConversationScroller({ children }: { children: ReactNode }) {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-4xl justify-end gap-3 p-6">
            {children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function LoadEarlier({
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

function quoteOf(message: Message, byEntry: Map<string, Message>) {
  return (
    message.replyPreview ??
    (message.replyTo ? byEntry.get(message.replyTo)?.content : undefined)
  );
}

function ConversationRows({
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
  reactions: Map<string, Reaction[]>;
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
        {isNotice(row.message) ? (
          <NoticeRow message={row.message} />
        ) : row.message.role === "user" ? (
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

function OutgoingRow({
  message,
  conversation,
}: {
  message: Outgoing;
  conversation: Conversation;
}) {
  const { byEntry, attachmentPath, sending } = conversation;

  return (
    <MessageScrollerItem messageId={message.requestId} className={ARRIVAL}>
      <OwnerMessage
        message={outgoingMessage(message)}
        uploads={message.uploads}
        quote={
          message.replyTo ? byEntry.get(message.replyTo)?.content : undefined
        }
        delivery={message.state}
        onRetry={() =>
          void sending.sendMessage(
            message.content,
            message.uploads,
            message.requestId,
            message.replyTo,
          )
        }
        attachmentPath={attachmentPath}
      />
    </MessageScrollerItem>
  );
}

export function ConversationMessages({
  conversation,
  empty,
  renderMessage,
}: {
  conversation: Conversation;
  empty: ReactNode;
  renderMessage: (message: Message) => ReactNode;
}) {
  const { hasMore, oldest, loadEarlier, shown, outgoing } = conversation;

  return (
    <>
      {hasMore && oldest && (
        <LoadEarlier
          pending={loadEarlier.isPending}
          onLoad={() => loadEarlier.mutate(oldest)}
        />
      )}
      {shown.length === 0 && outgoing.length === 0 && empty}
      <ConversationRows
        messages={shown}
        arrival={conversation.arrival}
        byEntry={conversation.byEntry}
        reactions={conversation.reactions}
        onReply={conversation.sending.setReplyTo}
        attachmentPath={conversation.attachmentPath}
        renderMessage={renderMessage}
      />
      {outgoing.map((message) => (
        <OutgoingRow
          key={message.requestId}
          message={message}
          conversation={conversation}
        />
      ))}
    </>
  );
}

export function SendError({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <p className="mx-auto w-full max-w-4xl px-4 text-xs text-destructive">
      {message}
    </p>
  );
}

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ComputerIcon,
  PencilEdit01Icon,
  SidebarRightIcon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  type HistoryPage,
  type Message,
  agentPath,
  api,
  botsQuery,
  chatQuery,
  jobsQuery,
  send,
} from "./api";
import { BotAvatar, botColor, botStyle } from "./avatar";
import { type Outgoing, confirm, deliver, useOutgoing } from "./delivery";
import { DetailsPanel } from "./details";
import { type JobRef, JobDialog } from "./jobs";
import { useChatStream } from "./live";
import { BotReasoning } from "./reasoning";
import {
  BotMessage,
  Composer,
  EventRow,
  OwnerMessage,
  TimeMarker,
  ToolResultRow,
  TypingDots,
  type Upload,
  ARRIVAL,
  useArrivals,
  jobOf,
  mergeMessages,
  reactionsOf,
  shownInChat,
  withTimeMarkers,
} from "./transcript";

const DETAILS_KEY = "crumble.details";

/** An outgoing message drawn like a transcript message until the server confirms it. */
export function outgoingMessage(message: Outgoing): Message {
  return {
    id: `local:${message.requestId}`,
    entryId: "",
    role: "user",
    content: message.content,
  };
}

export function Chat({ botId }: { botId: string }) {
  const chat = useQuery(chatQuery(botId));
  const bots = useQuery(botsQuery);
  const bot = bots.data?.find((each) => each.id === botId);
  const outgoing = useOutgoing(`bot:${botId}`);
  const [older, setOlder] = useState<HistoryPage | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [job, setJob] = useState<JobRef | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const [details, setDetails] = useState(
    () => localStorage.getItem(DETAILS_KEY) !== "off",
  );

  const path = agentPath(botId);

  useChatStream(botId);

  const live = chat.data?.messages;
  const { arrival, remember } = useArrivals(live);

  useEffect(() => {
    if (live)
      confirm(
        `bot:${botId}`,
        new Set(live.flatMap((message) => message.requestId ?? [])),
      );
  }, [botId, live]);

  const messages = mergeMessages(older?.messages ?? [], live ?? []);

  const jobMessages = messages.filter(
    (message) =>
      jobOf(message) !== null ||
      message.origin?.kind === "coding" ||
      message.origin?.kind === "desktop",
  ).length;

  const kinds = new Set(
    messages.flatMap((message) => jobOf(message)?.kind ?? []),
  );

  const codingJobs = useQuery({
    ...jobsQuery(botId, "coding", jobMessages),
    enabled: kinds.has("coding"),
  });

  const desktopJobs = useQuery({
    ...jobsQuery(botId, "desktop", jobMessages),
    enabled: kinds.has("desktop"),
  });

  const jobs = [...(codingJobs.data ?? []), ...(desktopJobs.data ?? [])];

  const loadEarlier = useMutation({
    mutationFn: (before: string) =>
      api<HistoryPage>(
        `${path}/chat/history?before=${encodeURIComponent(before)}&limit=100`,
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

  const stop = useMutation({ mutationFn: () => send(`${path}/abort`, "POST") });

  if (chat.isError)
    return (
      <Alert variant="destructive" className="m-6 w-auto">
        <AlertDescription>{chat.error.message}</AlertDescription>
      </Alert>
    );

  if (!chat.data || !bot)
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        {bots.isSuccess && !bot ? (
          <p className="text-muted-foreground">Bot not found.</p>
        ) : (
          <>
            <Skeleton className="h-10 w-1/2 self-end" />
            <Skeleton className="h-20 w-3/4" />
          </>
        )}
      </div>
    );

  const { status, error } = chat.data;
  const running = status === "running";
  const hasMore = older ? older.hasMore : chat.data.hasMore;
  const oldest = older ? older.oldestEntryId : chat.data.oldestEntryId;
  const reactions = reactionsOf(messages, false);

  const byEntry = new Map(
    messages.map((message) => [message.entryId, message]),
  );

  const shown = messages.filter(shownInChat);

  const mentionable = bot.tools.includes("delegate")
    ? (bots.data ?? []).filter(
        (other) =>
          other.enabled &&
          other.id !== bot.id &&
          bot.delegates.includes(other.id),
      )
    : [];

  const quoteOf = (message: Message) =>
    message.replyPreview ??
    (message.replyTo ? byEntry.get(message.replyTo)?.content : undefined);

  const toggleDetails = () => {
    localStorage.setItem(DETAILS_KEY, details ? "off" : "on");
    setDetails(!details);
  };

  const sendMessage = async (
    content: string,
    uploads: Upload[],
    requestId: string = randomId(),
    target = replyTo?.entryId,
  ) => {
    setReplyTo(null);
    setSendError(null);

    const failure = await deliver(
      `bot:${botId}`,
      `${path}/messages`,
      { requestId, content, uploads, ...(target && { replyTo: target }) },
      { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    );

    if (failure) setSendError(`Message was not confirmed: ${failure}`);

    return failure === null;
  };

  const attachmentPath = (entryId: string, index: number) =>
    `${path}/attachments/${encodeURIComponent(entryId)}/${index}`;

  const jobFor = (name?: string) => jobs.find((each) => each.name === name);

  return (
    <div className="flex min-h-0 flex-1" style={botStyle(botColor(bot))}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
          <BotAvatar
            bot={bot}
            size={32}
            state={running ? "working" : bot.enabled ? "idle" : "sleeping"}
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-heading font-semibold leading-tight">
              {bot.name}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {running ? "Working…" : bot.enabled ? bot.description : "Paused"}
            </span>
          </span>
          <div className="ml-auto flex gap-1">
            {bot.tools.includes("desktop") && (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Bot desktop"
                render={<Link to="/bots/$botId/desktop" params={{ botId }} />}
                nativeButton={false}
              >
                <HugeiconsIcon icon={ComputerIcon} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              title="Edit bot"
              render={<Link to="/bots/$botId/edit" params={{ botId }} />}
              nativeButton={false}
            >
              <HugeiconsIcon icon={PencilEdit01Icon} />
            </Button>
            <Button
              variant={details ? "secondary" : "ghost"}
              size="icon-sm"
              title="Details"
              aria-pressed={details}
              className="hidden lg:inline-flex"
              onClick={toggleDetails}
            >
              <HugeiconsIcon icon={SidebarRightIcon} />
            </Button>
          </div>
        </header>
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl justify-end gap-3 p-6">
                {hasMore && oldest && (
                  <MessageScrollerItem messageId="earlier">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mx-auto flex"
                      disabled={loadEarlier.isPending}
                      onClick={() => loadEarlier.mutate(oldest)}
                    >
                      Load earlier messages
                    </Button>
                  </MessageScrollerItem>
                )}
                {shown.length === 0 && outgoing.length === 0 && !running && (
                  <MessageScrollerItem messageId="empty">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>Say hello to {bot.name}</EmptyTitle>
                        <EmptyDescription>
                          {bot.description ||
                            "It keeps its memory and work between visits."}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </MessageScrollerItem>
                )}
                {withTimeMarkers(shown).map((row) =>
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
                          quote={quoteOf(row.message)}
                          reactions={reactions.get(row.message.entryId)}
                          onReply={setReplyTo}
                          attachmentPath={attachmentPath}
                        />
                      ) : row.message.role === "assistant" ? (
                        <BotMessage
                          message={row.message}
                          onReply={setReplyTo}
                        />
                      ) : row.message.role === "event" ? (
                        <EventRow message={row.message} />
                      ) : (
                        <ToolResultRow
                          message={row.message}
                          jobStatus={jobFor(jobOf(row.message)?.name)?.status}
                          onOpenJob={setJob}
                        />
                      )}
                    </MessageScrollerItem>
                  ),
                )}
                {outgoing.map((message) => (
                  <MessageScrollerItem
                    key={message.requestId}
                    messageId={message.requestId}
                    className={ARRIVAL}
                  >
                    <OwnerMessage
                      message={outgoingMessage(message)}
                      uploads={message.uploads}
                      quote={
                        message.replyTo
                          ? byEntry.get(message.replyTo)?.content
                          : undefined
                      }
                      delivery={message.state}
                      onRetry={() =>
                        void sendMessage(
                          message.content,
                          message.uploads,
                          message.requestId,
                          message.replyTo,
                        )
                      }
                      attachmentPath={attachmentPath}
                    />
                  </MessageScrollerItem>
                ))}
                {running && (
                  <MessageScrollerItem messageId="typing" className={ARRIVAL}>
                    <TypingDots />
                  </MessageScrollerItem>
                )}
                {error && !running && (
                  <MessageScrollerItem messageId="failure">
                    <Alert variant="destructive">
                      <AlertTitle>The bot couldn't finish</AlertTitle>
                      <AlertDescription className="flex flex-col items-start gap-2">
                        {error}
                        <Button
                          variant="outline"
                          size="sm"
                          render={<Link to="/settings/providers" />}
                          nativeButton={false}
                        >
                          Provider settings…
                        </Button>
                      </AlertDescription>
                    </Alert>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
        {sendError && (
          <p className="mx-auto w-full max-w-3xl px-4 text-xs text-destructive">
            {sendError}
          </p>
        )}
        <Composer
          key={botId}
          placeholder={
            bot.enabled
              ? `Message ${bot.name}`
              : `${bot.name} is paused. Enable it in its profile.`
          }
          disabled={!bot.enabled}
          running={running}
          replyingTo={
            replyTo ? (replyTo.role === "user" ? "You" : bot.name) : undefined
          }
          onCancelReply={() => setReplyTo(null)}
          mentionable={mentionable}
          actions={<BotReasoning bot={bot} />}
          onSend={(content, uploads) => sendMessage(content, uploads)}
          onStop={() => stop.mutate()}
        />
      </div>
      {details && <DetailsPanel bot={bot} />}
      {job && (
        <JobDialog
          botId={botId}
          job={job}
          status={jobFor(job.name)?.status}
          usage={jobFor(job.name)?.usage}
          onClose={() => setJob(null)}
        />
      )}
    </div>
  );
}

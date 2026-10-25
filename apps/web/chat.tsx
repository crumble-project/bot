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
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import {
  type Message,
  agentPath,
  botsQuery,
  chatQuery,
  jobsQuery,
  send,
} from "./api";
import { BotAvatar, botColor, botStyle } from "./avatar";
import { type Outgoing, confirm, useOutgoing } from "./delivery";
import {
  ConversationEmpty,
  ConversationError,
  ConversationLoading,
  ConversationRows,
  ConversationScroller,
  LoadEarlier,
  useHistory,
  useMessageSending,
} from "./conversation";
import { DetailsPanel } from "./details";
import { type JobRef, JobDialog } from "./jobs";
import { useChatStream } from "./live";
import { BotReasoning } from "./reasoning";
import {
  BotMessage,
  Composer,
  EventRow,
  OwnerMessage,
  ToolResultRow,
  TypingDots,
  ARRIVAL,
  useArrivals,
  jobOf,
  mergeMessages,
  reactionsOf,
  shownInChat,
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
  const [job, setJob] = useState<JobRef | null>(null);

  const [details, setDetails] = useState(
    () => localStorage.getItem(DETAILS_KEY) !== "off",
  );

  const path = agentPath(botId);

  const { replyTo, setReplyTo, sendError, sendMessage } = useMessageSending(
    `bot:${botId}`,
    path,
    () => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  );

  useChatStream(botId);

  const live = chat.data?.messages;
  const { arrival, remember } = useArrivals(live);
  const { older, loadEarlier } = useHistory(`${path}/chat/history`, remember);

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

  const stop = useMutation({ mutationFn: () => send(`${path}/abort`, "POST") });

  if (chat.isError) return <ConversationError error={chat.error} />;

  if (!chat.data || !bot)
    return <ConversationLoading notFound={bots.isSuccess && !bot} />;

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

  const toggleDetails = () => {
    localStorage.setItem(DETAILS_KEY, details ? "off" : "on");
    setDetails(!details);
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
        <ConversationScroller>
          {hasMore && oldest && (
            <LoadEarlier
              pending={loadEarlier.isPending}
              onLoad={() => loadEarlier.mutate(oldest)}
            />
          )}
          {shown.length === 0 && outgoing.length === 0 && !running && (
            <ConversationEmpty title={<>Say hello to {bot.name}</>}>
              It keeps its memory and work between visits.
            </ConversationEmpty>
          )}
          <ConversationRows
            messages={shown}
            arrival={arrival}
            byEntry={byEntry}
            reactions={reactions}
            onReply={setReplyTo}
            attachmentPath={attachmentPath}
            renderMessage={(message) =>
              message.role === "assistant" ? (
                <BotMessage message={message} onReply={setReplyTo} />
              ) : message.role === "event" ? (
                <EventRow message={message} />
              ) : (
                <ToolResultRow
                  message={message}
                  botId={botId}
                  jobStatus={jobFor(jobOf(message)?.name)?.status}
                  onOpenJob={setJob}
                />
              )
            }
          />
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
        </ConversationScroller>
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

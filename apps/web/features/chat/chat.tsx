import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  IconDeviceDesktop,
  IconPencil,
  IconLayoutSidebarRight,
} from "@tabler/icons-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import {
  type Bot,
  type ChatSnapshot,
  type Message,
  agentPath,
  botsQuery,
  chatQuery,
  jobsQuery,
  send,
} from "@/lib/api";
import { BotAvatar, botColor, botStyle } from "@/features/bots/avatar";
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
import { type JobRef, JobDialog } from "@/features/jobs/jobs";
import { useChatStream } from "@/lib/live";
import { BotReasoning } from "@/features/bots/reasoning";
import {
  BotMessage,
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
import { Composer } from "./composer";
import { type Sources, sourcesOf } from "./sources";
import { MobileSidebarTrigger } from "@/components/workspace";

const DETAILS_KEY = "crumble.details";

type SendMessage = ReturnType<typeof useMessageSending>["sendMessage"];

/** An outgoing message drawn like a transcript message until the server confirms it. */
export function outgoingMessage(message: Outgoing): Message {
  return {
    id: `local:${message.requestId}`,
    entryId: "",
    role: "user",
    content: message.content,
  };
}

function useDetails() {
  const [details, setDetails] = useState(
    () => localStorage.getItem(DETAILS_KEY) !== "off",
  );

  const toggleDetails = () => {
    localStorage.setItem(DETAILS_KEY, details ? "off" : "on");
    setDetails(!details);
  };

  return { details, toggleDetails };
}

function useChatMessages(botId: string, snapshot: ChatSnapshot | undefined) {
  useChatStream(botId);

  const path = agentPath(botId);
  const live = snapshot?.messages;
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

  return {
    messages,
    arrival,
    loadEarlier,
    hasMore: older ? older.hasMore : snapshot?.hasMore,
    oldest: older ? older.oldestEntryId : snapshot?.oldestEntryId,
    reactions: reactionsOf(messages, false),
    sources: sourcesOf(messages),
    byEntry: new Map(messages.map((message) => [message.entryId, message])),
    shown: messages.filter(shownInChat),
    attachmentPath: (entryId: string, index: number) =>
      `${path}/attachments/${encodeURIComponent(entryId)}/${index}`,
  };
}

function useChatJobs(botId: string, messages: Message[]) {
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

  return (name?: string) => jobs.find((each) => each.name === name);
}

function mentionableBots(bot: Bot, bots: Bot[]) {
  if (!bot.tools.includes("delegate")) return [];

  const delegates = new Set(bot.delegates);

  return bots.filter(
    (other) => other.enabled && other.id !== bot.id && delegates.has(other.id),
  );
}

function ChatHeader({
  bot,
  running,
  details,
  onToggleDetails,
}: {
  bot: Bot;
  running: boolean;
  details: boolean;
  onToggleDetails: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
      <MobileSidebarTrigger />
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
            render={
              <Link to="/bots/$botId/desktop" params={{ botId: bot.id }} />
            }
            nativeButton={false}
          >
            <IconDeviceDesktop />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title="Edit bot"
          render={<Link to="/bots/$botId/edit" params={{ botId: bot.id }} />}
          nativeButton={false}
        >
          <IconPencil />
        </Button>
        <Button
          variant={details ? "secondary" : "ghost"}
          size="icon-sm"
          title="Details"
          aria-pressed={details}
          className="hidden lg:inline-flex"
          onClick={onToggleDetails}
        >
          <IconLayoutSidebarRight />
        </Button>
      </div>
    </header>
  );
}

function ChatMessage({
  message,
  botId,
  jobFor,
  sources,
  onReply,
  onOpenJob,
}: {
  message: Message;
  botId: string;
  jobFor: ReturnType<typeof useChatJobs>;
  sources: Sources | undefined;
  onReply: (message: Message) => void;
  onOpenJob: (job: JobRef) => void;
}) {
  if (message.role === "assistant")
    return <BotMessage message={message} sources={sources} onReply={onReply} />;

  if (message.role === "event") return <EventRow message={message} />;

  return (
    <ToolResultRow
      message={message}
      botId={botId}
      jobStatus={jobFor(jobOf(message)?.name)?.status}
      onOpenJob={onOpenJob}
    />
  );
}

function OutgoingRow({
  message,
  byEntry,
  attachmentPath,
  sendMessage,
}: {
  message: Outgoing;
  byEntry: Map<string, Message>;
  attachmentPath: (entryId: string, index: number) => string;
  sendMessage: SendMessage;
}) {
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
  );
}

function ChatFailure({ error }: { error: string }) {
  return (
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
  );
}

function ChatTranscript({
  bot,
  transcript,
  outgoing,
  running,
  error,
  jobFor,
  onReply,
  onOpenJob,
  sendMessage,
}: {
  bot: Bot;
  transcript: ReturnType<typeof useChatMessages>;
  outgoing: Outgoing[];
  running: boolean;
  error: ChatSnapshot["error"];
  jobFor: ReturnType<typeof useChatJobs>;
  onReply: (message: Message) => void;
  onOpenJob: (job: JobRef) => void;
  sendMessage: SendMessage;
}) {
  const {
    hasMore,
    oldest,
    loadEarlier,
    shown,
    arrival,
    byEntry,
    reactions,
    sources,
    attachmentPath,
  } = transcript;

  return (
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
        onReply={onReply}
        attachmentPath={attachmentPath}
        renderMessage={(message) => (
          <ChatMessage
            message={message}
            botId={bot.id}
            jobFor={jobFor}
            sources={sources.get(message.id)}
            onReply={onReply}
            onOpenJob={onOpenJob}
          />
        )}
      />
      {outgoing.map((message) => (
        <OutgoingRow
          key={message.requestId}
          message={message}
          byEntry={byEntry}
          attachmentPath={attachmentPath}
          sendMessage={sendMessage}
        />
      ))}
      {running && (
        <MessageScrollerItem messageId="typing" className={ARRIVAL}>
          <TypingDots />
        </MessageScrollerItem>
      )}
      {error && !running && <ChatFailure error={error} />}
    </ConversationScroller>
  );
}

function ChatComposer({
  bot,
  bots,
  sending,
  running,
  onStop,
}: {
  bot: Bot;
  bots: Bot[];
  sending: ReturnType<typeof useMessageSending>;
  running: boolean;
  onStop: () => void;
}) {
  const { replyTo, setReplyTo, sendError, sendMessage } = sending;

  return (
    <>
      {sendError && (
        <p className="mx-auto w-full max-w-3xl px-4 text-xs text-destructive">
          {sendError}
        </p>
      )}
      <Composer
        key={bot.id}
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
        mentionable={mentionableBots(bot, bots)}
        actions={<BotReasoning bot={bot} />}
        onSend={(content, uploads) => sendMessage(content, uploads)}
        onStop={onStop}
      />
    </>
  );
}

function useChatDelivery(botId: string) {
  const outgoing = useOutgoing(`bot:${botId}`);
  const path = agentPath(botId);

  const sending = useMessageSending(`bot:${botId}`, path, () => ({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));

  // The live transcript reports the stopped turn.
  // react-doctor-disable-next-line query-mutation-missing-invalidation
  const stop = useMutation({ mutationFn: () => send(`${path}/abort`, "POST") });

  return { outgoing, sending, stop };
}

function ChatJobDialog({
  botId,
  job,
  jobFor,
  onClose,
}: {
  botId: string;
  job: JobRef;
  jobFor: ReturnType<typeof useChatJobs>;
  onClose: () => void;
}) {
  const current = jobFor(job.name);

  return (
    <JobDialog
      botId={botId}
      job={job}
      status={current?.status}
      usage={current?.usage}
      onClose={onClose}
    />
  );
}

export function Chat({ botId }: { botId: string }) {
  const chat = useQuery(chatQuery(botId));
  const bots = useQuery(botsQuery);
  const bot = bots.data?.find((each) => each.id === botId);
  const { outgoing, sending, stop } = useChatDelivery(botId);
  const [job, setJob] = useState<JobRef | null>(null);
  const { details, toggleDetails } = useDetails();
  const { setReplyTo, sendMessage } = sending;
  const transcript = useChatMessages(botId, chat.data);
  const jobFor = useChatJobs(botId, transcript.messages);

  if (chat.isError) return <ConversationError error={chat.error} />;

  if (!chat.data || !bot)
    return <ConversationLoading notFound={bots.isSuccess && !bot} />;

  const { status, error } = chat.data;
  const running = status === "running";

  return (
    <div className="flex min-h-0 flex-1" style={botStyle(botColor(bot))}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader
          bot={bot}
          running={running}
          details={details}
          onToggleDetails={toggleDetails}
        />
        <ChatTranscript
          bot={bot}
          transcript={transcript}
          outgoing={outgoing}
          running={running}
          error={error}
          jobFor={jobFor}
          onReply={setReplyTo}
          onOpenJob={setJob}
          sendMessage={sendMessage}
        />
        <ChatComposer
          bot={bot}
          bots={bots.data ?? []}
          sending={sending}
          running={running}
          onStop={() => stop.mutate()}
        />
      </div>
      {details && <DetailsPanel bot={bot} />}
      {job && (
        <ChatJobDialog
          botId={botId}
          job={job}
          jobFor={jobFor}
          onClose={() => setJob(null)}
        />
      )}
    </div>
  );
}

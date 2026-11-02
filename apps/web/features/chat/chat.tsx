import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import { LiveBotAvatar, botColor, botStyle } from "@/features/bots/avatar";
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
import { DetailsPanel, DetailsSheet } from "./details";
import { type JobRef, JobPanel } from "@/features/jobs/jobs";
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
import { HeldActionCard } from "./held-action";
import { JobQuestionCard } from "./job-question";
import { Composer } from "./composer";
import { type Sources, sourcesOf } from "./sources";
import { MobileSidebarTrigger } from "@/components/workspace";

const DETAILS_KEY = "crumble.details";

/** Tailwind's lg breakpoint, where the details panel fits beside the chat. */
const WIDE = "(min-width: 64rem)";

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

/** The details panel's state, the job pane that can take its place, and the sheet narrow screens use instead. */
function useDetails() {
  const [details, setDetails] = useState(
    () => localStorage.getItem(DETAILS_KEY) !== "off",
  );

  const [job, setJob] = useState<JobRef | null>(null);
  const [sheet, setSheet] = useState(false);

  const toggleDetails = () => {
    localStorage.setItem(DETAILS_KEY, details ? "off" : "on");
    setDetails(!details);
  };

  // An open job takes the details panel's place; the toggle brings the details back.
  const showDetails = () => {
    if (!matchMedia(WIDE).matches) return setSheet(true);

    if (!job) return toggleDetails();

    setJob(null);

    if (!details) toggleDetails();
  };

  return { details, toggleDetails, showDetails, job, setJob, sheet, setSheet };
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
    <header className="relative flex h-14 shrink-0 items-center px-4">
      <MobileSidebarTrigger />
      <button
        type="button"
        title={details ? "Hide details" : "Show details"}
        aria-expanded={details}
        onClick={onToggleDetails}
        className="absolute left-1/2 flex max-w-[calc(100%-6rem)] -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full border bg-card py-1 pr-3.5 pl-1 shadow-xs transition-[background-color,box-shadow] duration-150 hover:bg-muted hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none aria-expanded:bg-muted"
      >
        <LiveBotAvatar bot={bot} size={24} />
        <span className="truncate text-sm font-medium">{bot.name}</span>
        {running ? (
          <span
            title="Working…"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-bot-strong"
          />
        ) : (
          !bot.enabled && (
            <span className="text-xs text-muted-foreground">Paused</span>
          )
        )}
      </button>
    </header>
  );
}

/** An event in the chat: a card the owner acts on, such as a job's question, or a plain event row. */
function EventMessage({ message, botId }: { message: Message; botId: string }) {
  if (message.kind === "job-question" && message.jobQuestion)
    return (
      <JobQuestionCard
        botId={botId}
        question={message.jobQuestion}
        text={message.content}
      />
    );

  if (message.kind === "held-action" && message.heldAction)
    return (
      <HeldActionCard
        held={message.heldAction}
        title={message.content}
        botId={botId}
      />
    );

  return <EventRow message={message} />;
}

function ChatMessage({
  message,
  botId,
  jobFor,
  sources,
  onReply,
  onOpenJob,
  attachmentPath,
}: {
  message: Message;
  botId: string;
  jobFor: ReturnType<typeof useChatJobs>;
  sources: Sources | undefined;
  onReply: (message: Message) => void;
  onOpenJob: (job: JobRef) => void;
  attachmentPath: (entryId: string, index: number) => string;
}) {
  if (message.role === "assistant")
    return <BotMessage message={message} sources={sources} onReply={onReply} />;

  if (message.role === "event")
    return <EventMessage message={message} botId={botId} />;

  return (
    <ToolResultRow
      message={message}
      botId={botId}
      jobStatus={jobFor(jobOf(message)?.name)?.status}
      onOpenJob={onOpenJob}
      attachmentPath={attachmentPath}
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
            attachmentPath={attachmentPath}
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
        <p className="mx-auto w-full max-w-4xl px-4 text-xs text-destructive">
          {sendError}
        </p>
      )}
      <Composer
        key={bot.id}
        draftKey={`bot:${bot.id}`}
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

export function Chat({ botId }: { botId: string }) {
  const chat = useQuery(chatQuery(botId));
  const bots = useQuery(botsQuery);
  const bot = bots.data?.find((each) => each.id === botId);
  const { outgoing, sending, stop } = useChatDelivery(botId);

  const { details, toggleDetails, showDetails, job, setJob, sheet, setSheet } =
    useDetails();

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
          details={details && !job}
          onToggleDetails={showDetails}
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
      {job ? (
        <JobPanel
          key={`${job.kind}:${job.name}`}
          botId={botId}
          job={job}
          onClose={() => setJob(null)}
        />
      ) : (
        details && <DetailsPanel bot={bot} onClose={toggleDetails} />
      )}
      <DetailsSheet bot={bot} open={sheet} onOpenChange={setSheet} />
    </div>
  );
}

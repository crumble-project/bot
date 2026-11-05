import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import {
  type Bot,
  agentPath,
  botsQuery,
  refreshBots,
} from "@/features/bots/api";
import { type ChatSnapshot, type Message, chatQuery } from "./api";
import { refreshJobs, useJobs } from "@/features/jobs/api";
import { jobOf } from "@/features/jobs/job-card";
import { send } from "@/lib/api";
import { BotAvatar, botColor, botStyle } from "@/components/bot-avatar";
import { LiveBotAvatar } from "@/features/bots/avatar";
import { activityLabel, useActivity } from "@/features/bots/activity";
import {
  type Conversation,
  ConversationEmpty,
  ConversationError,
  ConversationLoading,
  ConversationMessages,
  ConversationScroller,
  SendError,
  useConversation,
} from "./conversation";
import type { ConversationTarget } from "./conversation-target";
import { DetailsPanel, DetailsSheet } from "./details";
import { JobPanel } from "@/features/jobs/jobs";
import { type JobRef, isJobKind } from "@/lib/job-kinds";
import { BotReasoning } from "@/features/bots/reasoning";
import { BotMessage, EventRow, ARRIVAL } from "./transcript";
import type { ToolResultChat } from "./tool-result";
import { ToolResultRow, shownInChat } from "./tool-results";
import { HeldActionCard } from "./held-action";
import { JobQuestionCard } from "./job-question";
import { Composer } from "./composer";
import type { Sources } from "@/lib/sources";
import { sourcesOf } from "./sources";
import { MobileSidebarTrigger } from "@/components/workspace";
import { BOT_TOOL } from "@crumble/server/contract/tools";

const DETAILS_KEY = "crumble.details";

/** Tailwind's lg breakpoint, where the details panel fits beside the chat. */
const WIDE = "(min-width: 64rem)";

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

const botConversation = (id: string): ConversationTarget<ChatSnapshot> => {
  const path = agentPath(id);

  return {
    key: `bot:${id}`,
    path,
    history: `${path}/chat/history`,
    query: chatQuery(id),
    shown: shownInChat,
    reactionTarget: (_message, lastOwner) => lastOwner,
    sendContext: () => ({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    stop: () => send<"abort">(`${path}/abort`, "POST"),
    followsAfterView: (snapshot) => snapshot.status === "running",
    refreshList: refreshBots,
  };
};

function useChatJobs(botId: string, messages: Message[]) {
  const jobs = messages.flatMap((message) => jobOf(message) ?? []);
  const kinds = new Set(jobs.map((job) => job.kind));
  const coding = useJobs(botId, "coding", kinds.has("coding"));
  const desktop = useJobs(botId, "desktop", kinds.has("desktop"));

  const jobMessages =
    jobs.length +
    messages.filter((message) => isJobKind(message.origin?.kind)).length;

  const counted = useRef(jobMessages);

  // A job's message means its status may have changed.
  useEffect(() => {
    if (counted.current === jobMessages) return;
    counted.current = jobMessages;
    void refreshJobs(botId, "coding");
    void refreshJobs(botId, "desktop");
  }, [botId, jobMessages]);

  return ({ kind, name }: JobRef) =>
    (kind === "coding" ? coding : desktop).data?.find(
      (each) => each.name === name,
    )?.status;
}

function mentionableBots(bot: Bot, bots: Bot[]) {
  if (!bot.tools.includes(BOT_TOOL.delegate)) return [];

  return bots.filter((other) => other.enabled && other.id !== bot.id);
}

function BotNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <p className="text-muted-foreground">Bot not found.</p>
    </div>
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
  chat,
  sources,
  onReply,
}: {
  message: Message;
  chat: ToolResultChat;
  sources: Sources | undefined;
  onReply: (message: Message) => void;
}) {
  if (message.role === "assistant")
    return <BotMessage message={message} sources={sources} onReply={onReply} />;

  if (message.role === "event")
    return <EventMessage message={message} botId={chat.botId} />;

  return <ToolResultRow message={message} chat={chat} />;
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
  conversation,
  running,
  error,
  jobStatus,
  onOpenJob,
}: {
  bot: Bot;
  conversation: Conversation;
  running: boolean;
  error: ChatSnapshot["error"];
  jobStatus: ReturnType<typeof useChatJobs>;
  onOpenJob: (job: JobRef) => void;
}) {
  const sources = sourcesOf(conversation.messages);

  const chat: ToolResultChat = {
    botId: bot.id,
    attachmentPath: conversation.attachmentPath,
    jobStatus,
    onOpenJob,
  };

  return (
    <ConversationScroller>
      <ConversationMessages
        conversation={conversation}
        empty={
          !running && (
            <ConversationEmpty title={<>Say hello to {bot.name}</>}>
              It keeps its memory and work between visits.
            </ConversationEmpty>
          )
        }
        renderMessage={(message) => (
          <ChatMessage
            message={message}
            chat={chat}
            sources={sources.get(message.id)}
            onReply={conversation.sending.setReplyTo}
          />
        )}
      />
      {running && (
        <MessageScrollerItem messageId="typing" className={ARRIVAL}>
          <WorkingStatus bot={bot} />
        </MessageScrollerItem>
      )}
      {error && !running && <ChatFailure error={error} />}
    </ConversationScroller>
  );
}

function WorkingStatus({ bot }: { bot: Bot }) {
  const activity = useActivity(bot.id);

  return (
    <div className="flex items-center gap-2.5">
      <BotAvatar bot={bot} size={32} live state="working" />
      <span className="animate-pulse text-sm text-muted-foreground">
        {activityLabel[activity]}…
      </span>
    </div>
  );
}

function ChatComposer({
  bot,
  bots,
  draftKey,
  sending,
  running,
  onStop,
}: {
  bot: Bot;
  bots: Bot[];
  draftKey: string;
  sending: Conversation["sending"];
  running: boolean;
  onStop: () => void;
}) {
  const { replyTo, setReplyTo, sendError, sendMessage } = sending;

  return (
    <>
      <SendError message={sendError} />
      <Composer
        key={bot.id}
        draftKey={draftKey}
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

export function Chat({ botId }: { botId: string }) {
  const target = useMemo(() => botConversation(botId), [botId]);
  const { snapshot, ...conversation } = useConversation(target);
  const bots = useQuery(botsQuery);
  const bot = bots.data?.find((each) => each.id === botId);

  const { details, toggleDetails, showDetails, job, setJob, sheet, setSheet } =
    useDetails();

  const jobStatus = useChatJobs(botId, conversation.messages);

  if (snapshot.isError) return <ConversationError error={snapshot.error} />;

  if (bots.isSuccess && !bot) return <BotNotFound />;

  if (!snapshot.data || !bot) return <ConversationLoading />;

  const { status, error } = snapshot.data;
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
          conversation={conversation}
          running={running}
          error={error}
          jobStatus={jobStatus}
          onOpenJob={setJob}
        />
        <ChatComposer
          bot={bot}
          bots={bots.data ?? []}
          draftKey={target.key}
          sending={conversation.sending}
          running={running}
          onStop={() => conversation.stop.mutate()}
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

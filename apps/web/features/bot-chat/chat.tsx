import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import {
  type Bot,
  agentPath,
  botsQuery,
  invalidateBots,
} from "@/features/bots/api";
import {
  type ChatSnapshot,
  type Message,
  chatQuery,
} from "@/features/chat/api";
import { useChatJobs } from "@/features/jobs/chat-jobs";
import { send } from "@/lib/api";
import { BotAvatar, botColor, botStyle } from "@/components/bot-avatar";
import { LiveBotAvatar } from "./avatar";
import { workingLabel, useWorking } from "./working";
import {
  type Conversation,
  ConversationEmpty,
  ConversationError,
  ConversationLoading,
  ConversationMessages,
  ConversationScroller,
  SendError,
  useConversation,
} from "@/features/chat/conversation";
import type { ConversationTarget } from "@/features/chat/conversation-target";
import { DetailsPanel, DetailsSheet } from "./details";
import { JobPanel } from "@/features/jobs/jobs";
import { CallPanel } from "@/features/call-requests/call-panel";
import { CallNotice } from "@/features/call-requests/call-request-card";
import type { JobRef } from "@/features/jobs/api";
import { BotReasoning } from "@/features/bots/reasoning";
import { BotMessage, ARRIVAL } from "@/features/chat/transcript";
import type { CardChat } from "@/features/chat/message-card";
import { EventMessage, ToolResultRow, shownInChat } from "./chat-cards";
import { Composer } from "@/features/chat/composer";
import { MobileSidebarTrigger } from "@/components/page";
import { BOT_TOOL } from "@crumble/server/contract/tools";

const DETAILS_KEY = "crumble.details";

/** Tailwind's lg breakpoint, where the details panel fits beside the chat. */
const WIDE = "(min-width: 64rem)";

function useDetails() {
  const [details, setDetails] = useState(
    () => localStorage.getItem(DETAILS_KEY) !== "off",
  );

  const [job, openJob] = useState<JobRef | null>(null);
  const [call, openCall] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

  // One panel beside the chat: opening a job closes a call and the reverse,
  // and selecting the open card again closes its panel.
  const setJob = (next: JobRef | null) => {
    openCall(null);
    openJob((open) =>
      next && open?.kind === next.kind && open.name === next.name ? null : next,
    );
  };

  const setCall = (next: string | null) => {
    openJob(null);
    openCall((open) => (open === next ? null : next));
  };

  const toggleDetails = () => {
    localStorage.setItem(DETAILS_KEY, details ? "off" : "on");
    setDetails(!details);
  };

  const showDetails = () => {
    if (!matchMedia(WIDE).matches) return setSheet(true);

    if (!job && !call) return toggleDetails();

    setJob(null);

    if (!details) toggleDetails();
  };

  return {
    details,
    toggleDetails,
    showDetails,
    job,
    setJob,
    call,
    setCall,
    sheet,
    setSheet,
  };
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
    refreshList: invalidateBots,
  };
};

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

function ChatMessage({
  message,
  chat,
  onReply,
}: {
  message: Message;
  chat: CardChat;
  onReply: (message: Message) => void;
}) {
  if (message.role === "assistant")
    return <BotMessage message={message} onReply={onReply} />;

  if (message.role === "event")
    return <EventMessage message={message} chat={chat} />;

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
  onOpenCall,
}: {
  bot: Bot;
  conversation: Conversation;
  running: boolean;
  error: ChatSnapshot["error"];
  jobStatus: ReturnType<typeof useChatJobs>;
  onOpenJob: (job: JobRef) => void;
  onOpenCall: (requestId: string) => void;
}) {
  const chat: CardChat = {
    botId: bot.id,
    botName: bot.name,
    attachmentPath: conversation.attachmentPath,
    jobStatus,
    onOpenJob,
    onOpenCall,
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
        renderNotice={(message, row) => (
          <CallNotice message={message} chat={chat} fallback={row} />
        )}
        renderMessage={(message) => (
          <ChatMessage
            message={message}
            chat={chat}
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
  const activity = useWorking(bot.id);

  return (
    <div className="flex items-center gap-2.5">
      <BotAvatar bot={bot} size={32} live state="working" />
      <span className="animate-pulse text-sm text-muted-foreground">
        {workingLabel[activity]}…
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

function SidePanel({
  bot,
  job,
  call,
  details,
  onCloseJob,
  onCloseCall,
  onCloseDetails,
}: {
  bot: Bot;
  job: JobRef | null;
  call: string | null;
  details: boolean;
  onCloseJob: () => void;
  onCloseCall: () => void;
  onCloseDetails: () => void;
}) {
  if (job)
    return (
      <JobPanel
        key={`${job.kind}:${job.name}`}
        botId={bot.id}
        job={job}
        onClose={onCloseJob}
      />
    );

  if (call)
    return (
      <CallPanel
        key={call}
        botId={bot.id}
        botName={bot.name}
        requestId={call}
        onClose={onCloseCall}
      />
    );

  return details ? <DetailsPanel bot={bot} onClose={onCloseDetails} /> : null;
}

export function Chat({ botId }: { botId: string }) {
  const target = useMemo(() => botConversation(botId), [botId]);
  const { snapshot, ...conversation } = useConversation(target);
  const bots = useQuery(botsQuery);
  const bot = bots.data?.find((each) => each.id === botId);

  const {
    details,
    toggleDetails,
    showDetails,
    job,
    setJob,
    call,
    setCall,
    sheet,
    setSheet,
  } = useDetails();

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
          details={details && !job && !call}
          onToggleDetails={showDetails}
        />
        <ChatTranscript
          bot={bot}
          conversation={conversation}
          running={running}
          error={error}
          jobStatus={jobStatus}
          onOpenJob={setJob}
          onOpenCall={setCall}
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
      <SidePanel
        bot={bot}
        job={job}
        call={call}
        details={details}
        onCloseJob={() => setJob(null)}
        onCloseCall={() => setCall(null)}
        onCloseDetails={toggleDetails}
      />
      <DetailsSheet bot={bot} open={sheet} onOpenChange={setSheet} />
    </div>
  );
}

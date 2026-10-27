import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  ComputerIcon,
  Copy01Icon,
  File02Icon,
  HammerIcon,
  Key01Icon,
  PencilEdit01Icon,
  ReplyIcon,
  Tick02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Bubble, BubbleContent, BubbleReactions } from "@/components/ui/bubble";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Message as MessageRow,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  type Bot,
  type BotInput,
  type BotRequest,
  type Credential,
  type Message,
  blobUrl,
  botRequestPath,
  botRequestsQuery,
  botsQuery,
  call,
  credentialPath,
  credentialsQuery,
  mcpServersQuery,
  queryClient,
  send,
} from "@/lib/api";
import { BotAvatar, botStyle } from "@/features/bots/avatar";
import { BotFields, CAPABILITIES } from "@/features/bots/bot-form";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import type { Upload } from "./composer";
import { DisplayCard, displayOf } from "./display";
import { Reply } from "@/components/markdown";

/** Orders `agent:entry:index` message IDs numerically; others keep their place at the end. */
function position(id: string) {
  const parts = id.split(":");
  const entry = Number(parts.at(-2));
  const index = Number(parts.at(-1));

  return Number.isFinite(entry) && Number.isFinite(index)
    ? [entry, index]
    : [Infinity, 0];
}

/** Merges older pages into the live page by ID, in transcript order. */
export function mergeMessages(older: Message[], live: Message[]) {
  const byId = new Map<string, Message>();

  for (const message of [...older, ...live]) byId.set(message.id, message);

  return [...byId.values()].sort((a, b) => {
    const [ae, ai] = position(a.id);
    const [be, bi] = position(b.id);

    return ae! - be! || ai! - bi!;
  });
}

function hasText(message: Message) {
  if (!Array.isArray(message.blocks)) return message.content.trim() !== "";

  // SAFETY: Provider content blocks are objects with a `type`; text blocks carry `text`.
  const blocks = message.blocks as { type?: string; text?: string }[];

  return blocks.some(
    (block) => block.type === "text" && Boolean(block.text?.trim()),
  );
}

export type JobDetails = { name: string; status?: string };

/** A coding or desktop job a tool result started or messaged. */
export function jobOf(message: Message) {
  if (message.role !== "toolResult" || message.isError) return null;

  if (message.toolName !== "coding" && message.toolName !== "desktop")
    return null;

  // SAFETY: Job tool results carry the job's name and status in their details.
  const details = message.toolDetails as Partial<JobDetails> | undefined;

  const kind: "coding" | "desktop" =
    message.toolName === "coding" ? "coding" : "desktop";

  return details?.name
    ? {
        kind,
        name: details.name,
        status: details.status,
      }
    : null;
}

/** The credential a `request_credential` result asked the owner for. */
export function credentialRequestOf(message: Message) {
  if (
    message.role !== "toolResult" ||
    message.isError ||
    message.toolName !== "request_credential"
  )
    return null;

  // SAFETY: The tool stores the saved request, with its name and hosts, as its details.
  const details = message.toolDetails as
    | { name?: string; hosts?: string[]; requestedAt?: string }
    | undefined;

  return details?.name
    ? {
        name: details.name,
        hosts: details.hosts ?? [],
        ...(details.requestedAt && { requestedAt: details.requestedAt }),
      }
    : null;
}

export function botRequestOf(message: Message): BotRequest | null {
  if (
    message.role !== "toolResult" ||
    message.isError ||
    message.toolName !== "request_bot"
  )
    return null;

  // SAFETY: request_bot stores the validated request in toolDetails.
  const details = message.toolDetails as BotRequest | undefined;

  return details?.id && details.proposal ? details : null;
}

function userShown(message: Message) {
  return (
    (message.content.trim() !== "" || Boolean(message.attachments?.length)) &&
    message.origin?.kind !== "coding" &&
    message.origin?.kind !== "desktop"
  );
}

function toolResultShown(message: Message) {
  return (
    displayOf(message) !== null ||
    jobOf(message) !== null ||
    credentialRequestOf(message) !== null ||
    botRequestOf(message) !== null
  );
}

export function shownInChat(message: Message) {
  switch (message.role) {
    case "user":
      return userShown(message);
    case "assistant":
      return hasText(message);
    case "toolResult":
      return toolResultShown(message);
    case "event":
      return message.content.trim() !== "";
    default:
      return false;
  }
}

function reactionEmoji(message: Message) {
  if (message.role !== "toolResult" || message.toolName !== "react") return;

  if (message.isError) return;

  // SAFETY: The react tool records the emoji it sent in its details.
  return (message.toolDetails as { emoji?: string } | undefined)?.emoji;
}

function reactionLabel(message: Message, emoji: string, group: boolean) {
  return group && message.origin?.name
    ? `${message.origin.name} ${emoji}`
    : emoji;
}

function addReaction(
  reactions: Map<string, string[]>,
  target: string,
  label: string,
) {
  reactions.set(target, [...(reactions.get(target) ?? []), label]);
}

/** Emoji reactions from the `react` tool, keyed by the message they react to. */
export function reactionsOf(messages: Message[], group: boolean) {
  const reactions = new Map<string, string[]>();
  let lastUser: string | undefined;

  for (const message of messages) {
    if (message.role === "user" && message.entryId) lastUser = message.entryId;

    const emoji = reactionEmoji(message);
    const target = group ? message.replyTo : lastUser;

    if (!emoji || !target) continue;

    addReaction(reactions, target, reactionLabel(message, emoji, group));
  }

  return reactions;
}

function timeLabel(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();

  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (date.toDateString() === now.toDateString()) return `Today ${time}`;

  return date.getFullYear() === now.getFullYear()
    ? `${date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** Rows for a transcript, with a time marker where more than 30 minutes pass. */
export function withTimeMarkers(messages: Message[]) {
  const rows: (
    | { kind: "time"; key: string; label: string }
    | { kind: "message"; message: Message }
  )[] = [];

  let last = 0;

  for (const message of messages) {
    if (message.timestamp && message.timestamp - last > 30 * 60_000)
      rows.push({
        kind: "time",
        key: `time-${message.id}`,
        label: timeLabel(message.timestamp),
      });

    if (message.timestamp) last = message.timestamp;
    rows.push({ kind: "message", message });
  }

  return rows;
}

export const ARRIVAL =
  "animate-in fade-in slide-in-from-bottom-2 duration-200 ease-out";

/**
 * Animates only messages that arrive while the transcript is open, not the
 * history already there when it loaded or pages fetched by scrolling back.
 */
export function useArrivals(live: Message[] | undefined) {
  const seen = useRef<Set<string> | null>(null);

  if (live && !seen.current)
    seen.current = new Set(live.map((message) => message.id));

  return {
    remember: (messages: Message[]) =>
      messages.forEach((message) => seen.current?.add(message.id)),
    // A confirmed owner message replaces its outgoing copy, which already animated.
    arrival: (message: Message) =>
      seen.current &&
      !seen.current.has(message.id) &&
      !(message.role === "user" && message.requestId)
        ? ARRIVAL
        : undefined,
  };
}

export function TimeMarker({ label }: { label: string }) {
  return (
    <Marker variant="separator">
      <MarkerContent className="tabular-nums">{label}</MarkerContent>
    </Marker>
  );
}

export function EventRow({ message }: { message: Message }) {
  const communication = message.communication;

  const title =
    message.kind === "bot-message" && communication
      ? `Bot communication: ${communication.fromName} → ${communication.toName}`
      : message.kind === "reset"
        ? "Context reset"
        : "Earlier messages summarized";

  const status =
    communication &&
    {
      sent: "Sent",
      done: "Reply",
      failed: "Failed",
      cancelled: "Cancelled",
    }[communication.status];

  return (
    <CenteredDisclosure
      title={title}
      badge={status}
      content={message.content}
    />
  );
}

/** A turn the owner didn't send, such as a task or another bot's message: centered, with its text on demand. */
export function NoticeRow({ message }: { message: Message }) {
  return (
    <CenteredDisclosure
      title={originLabel(message)}
      content={message.content}
    />
  );
}

/** Whether a user-role message came from somewhere other than the owner. */
export function isNotice(message: Message) {
  return message.role === "user" && originLabel(message) !== null;
}

function CenteredDisclosure({
  title,
  badge,
  content,
}: {
  title: ReactNode;
  badge?: string | undefined;
  content: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        {title}
        {badge && <Badge variant="outline">{badge}</Badge>}
      </button>
      {open && (
        <div className="rounded-lg bg-muted/50 p-3 text-sm">
          <Reply source={content} />
        </div>
      )}
    </div>
  );
}

function AttachmentImage({ path, name }: { path: string; name: string }) {
  const image = useQuery({
    queryKey: ["attachment", path],
    queryFn: ({ signal }) => blobUrl(path, signal),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });

  return image.data ? (
    <img
      src={image.data}
      alt={name}
      className="max-h-64 max-w-full rounded-lg object-contain outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
    />
  ) : (
    <div className="size-32 animate-pulse rounded-lg bg-muted" />
  );
}

export function Attachments({
  message,
  attachmentPath,
}: {
  message: Message;
  attachmentPath: (entryId: string, index: number) => string;
}) {
  if (!message.attachments?.length) return null;

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {message.attachments.map((attachment, index) =>
        attachment.kind === "image" ? (
          <AttachmentImage
            key={index}
            name={attachment.name}
            path={attachmentPath(message.entryId, index)}
          />
        ) : (
          <Badge key={index} variant="outline">
            <HugeiconsIcon icon={File02Icon} data-icon="inline-start" />
            {attachment.name}
          </Badge>
        ),
      )}
    </div>
  );
}

function originLabel(message: Message) {
  const origin = message.origin;

  if (!origin) return null;

  if (origin.kind === "owner")
    return botRequestNotice(message) ? "Bot request" : null;

  if (origin.kind === "bot_request") return "Bot request";

  return originContent(origin);
}

function botRequestNotice(message: Message) {
  return message.requestId?.startsWith("bot-request:") === true;
}

function originContent(origin: NonNullable<Message["origin"]>) {
  if (origin.kind === "task") return `Task · ${origin.name ?? ""}`;

  if (origin.kind === "script") return `Script task · ${origin.name ?? ""}`;

  if (origin.kind === "credential")
    return (
      <span className="flex items-center gap-1">
        <HugeiconsIcon icon={Key01Icon} className="size-3" />
        Credential · {origin.name}
      </span>
    );

  if (origin.kind === "bot")
    return (
      <span className="flex items-center gap-1">
        <HugeiconsIcon icon={UserGroupIcon} className="size-3" />
        From {origin.name}
      </span>
    );

  return null;
}

export function MessageActions({
  message,
  onReply,
}: {
  message: Message;
  onReply?: ((message: Message) => void) | undefined;
}) {
  const canReply =
    onReply &&
    message.entryId &&
    (message.role === "user" || message.role === "assistant");

  return (
    <div className="flex gap-1">
      {canReply && (
        <Button
          variant="ghost"
          size="icon-xs"
          title="Reply"
          onClick={() => onReply(message)}
        >
          <HugeiconsIcon icon={ReplyIcon} />
        </Button>
      )}
      <CopyButton text={message.content} />
    </div>
  );
}

const ICON_SWAP =
  "transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), 1500);

    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={copied ? "Copied" : "Copy"}
      className="relative"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => setCopied(true))
      }
    >
      <HugeiconsIcon
        icon={Copy01Icon}
        className={cn(ICON_SWAP, copied && "scale-25 opacity-0 blur-[4px]")}
      />
      <HugeiconsIcon
        icon={Tick02Icon}
        className={cn(
          ICON_SWAP,
          "absolute",
          !copied && "scale-25 opacity-0 blur-[4px]",
        )}
      />
    </Button>
  );
}

function MessageReactions({
  reactions,
  align,
}: {
  reactions: string[] | undefined;
  align: "start" | "end";
}) {
  if (!reactions || reactions.length === 0) return null;

  return (
    <BubbleReactions side="bottom" align={align}>
      <Badge variant="secondary" title={reactions.join(", ")}>
        {reactions.map((reaction) => reaction.split(" ").at(-1)).join("")}
      </Badge>
    </BubbleReactions>
  );
}

export type Delivery = "sending" | "failed";

/** An owner message: right-aligned bubble with reply quote, attachments, reactions, and delivery state. */
export function OwnerMessage({
  message,
  uploads,
  quote,
  reactions,
  delivery,
  onRetry,
  onReply,
  attachmentPath,
}: {
  message: Message;
  /** Files of a message not confirmed yet, shown from local data. */
  uploads?: Upload[];
  quote?: string | undefined;
  reactions?: string[] | undefined;
  delivery?: Delivery;
  onRetry?: () => void;
  onReply?: ((message: Message) => void) | undefined;
  attachmentPath: (entryId: string, index: number) => string;
}) {
  return (
    <MessageRow align="end">
      <MessageContent>
        <OwnerMessageBody
          message={message}
          uploads={uploads}
          quote={quote}
          reactions={reactions}
          delivery={delivery}
          onRetry={onRetry}
          onReply={onReply}
          attachmentPath={attachmentPath}
        />
      </MessageContent>
    </MessageRow>
  );
}

function OwnerMessageBody({
  message,
  uploads,
  quote,
  reactions,
  delivery,
  onRetry,
  onReply,
  attachmentPath,
}: {
  message: Message;
  uploads?: Upload[] | undefined;
  quote?: string | undefined;
  reactions?: string[] | undefined;
  delivery?: Delivery | undefined;
  onRetry?: (() => void) | undefined;
  onReply?: ((message: Message) => void) | undefined;
  attachmentPath: (entryId: string, index: number) => string;
}) {
  return (
    <>
      {quote && (
        <div className="line-clamp-2 self-end border-r-2 pr-2 text-xs text-muted-foreground">
          {quote}
        </div>
      )}
      <Attachments message={message} attachmentPath={attachmentPath} />
      <OwnerUploads uploads={uploads} />
      <OwnerContent
        message={message}
        delivery={delivery}
        reactions={reactions}
        onReply={onReply}
      />
      <OwnerDelivery
        message={message}
        delivery={delivery}
        onRetry={onRetry}
        onReply={onReply}
      />
    </>
  );
}

function OwnerUploads({ uploads }: { uploads?: Upload[] | undefined }) {
  if (!uploads?.length) return null;

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {uploads.map((upload, index) =>
        upload.preview ? (
          <img
            key={index}
            src={upload.preview}
            alt={upload.name}
            className="max-h-64 max-w-full rounded-lg object-contain"
          />
        ) : (
          <Badge key={index} variant="outline">
            <HugeiconsIcon icon={File02Icon} data-icon="inline-start" />
            {upload.name}
          </Badge>
        ),
      )}
    </div>
  );
}

function OwnerContent({
  message,
  delivery,
  reactions,
  onReply,
}: {
  message: Message;
  delivery?: Delivery | undefined;
  reactions?: string[] | undefined;
  onReply?: ((message: Message) => void) | undefined;
}) {
  if (!message.content.trim()) return null;

  return (
    <div className="flex w-full min-w-0 items-center justify-end gap-1">
      {!delivery && (
        <MessageFooter className="shrink-0 px-0">
          <MessageActions message={message} onReply={onReply} />
        </MessageFooter>
      )}
      <Bubble variant="secondary" align="end">
        <BubbleContent className="whitespace-pre-wrap">
          {message.content}
        </BubbleContent>
        <MessageReactions reactions={reactions} align="end" />
      </Bubble>
    </div>
  );
}

function OwnerDelivery({
  message,
  delivery,
  onRetry,
  onReply,
}: {
  message: Message;
  delivery?: Delivery | undefined;
  onRetry?: (() => void) | undefined;
  onReply?: ((message: Message) => void) | undefined;
}) {
  return (
    <MessageFooter className="gap-2">
      {delivery === "sending" && (
        <span className="flex items-center gap-1">
          <Spinner className="size-3" />
          Sending…
        </span>
      )}
      {delivery === "failed" && (
        <span className="flex items-center gap-1 text-destructive">
          Not sent
          <Button variant="link" size="xs" onClick={onRetry}>
            Retry
          </Button>
        </span>
      )}
      {!delivery && !message.content.trim() && (
        <MessageActions message={message} onReply={onReply} />
      )}
    </MessageFooter>
  );
}

/** A bot's message: Markdown bubble, optionally with the sender for group chats. */
export function BotMessage({
  message,
  sender,
  color,
  reactions,
  onReply,
}: {
  message: Message;
  sender?: ReactNode;
  /** The sender's color, where the transcript mixes bots. */
  color?: string | undefined;
  reactions?: string[] | undefined;
  onReply?: ((message: Message) => void) | undefined;
}) {
  return (
    <MessageRow align="start">
      <MessageContent>
        {sender && <MessageHeader>{sender}</MessageHeader>}
        <div className="flex w-full min-w-0 items-center gap-1">
          <Bubble
            variant="secondary"
            className="*:data-[slot=bubble-content]:bg-bot-soft!"
            style={color ? botStyle(color) : undefined}
          >
            <BubbleContent>
              <Reply source={message.content} />
            </BubbleContent>
            <MessageReactions reactions={reactions} align="start" />
          </Bubble>
          <MessageFooter className="shrink-0 px-0">
            <MessageActions message={message} onReply={onReply} />
          </MessageFooter>
        </div>
      </MessageContent>
    </MessageRow>
  );
}

function SettledCard({
  icon,
  title,
  outcome,
  action,
}: {
  icon: typeof Key01Icon;
  title: string;
  outcome: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex w-full max-w-sm items-center gap-3 rounded-xl border p-3">
      <HugeiconsIcon icon={icon} className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{outcome}</span>
      {action}
    </div>
  );
}

function CredentialRequestCard({
  credential,
  botId,
}: {
  credential: { name: string; hosts: string[]; requestedAt?: string };
  botId: string;
}) {
  const state = useQuery(credentialsQuery(botId));

  const current = state.data;

  const request = current?.requests.find(
    (item) =>
      item.name === credential.name &&
      (!credential.requestedAt || item.requestedAt === credential.requestedAt),
  );

  const saved = current?.credentials.find(
    (item) => item.name === credential.name,
  );

  if (!state.isSuccess)
    return (
      <SettledCard
        icon={Key01Icon}
        title={credential.name}
        outcome={state.isError ? "Unavailable" : "Loading…"}
      />
    );

  if (!request && saved)
    return (
      <SettledCard icon={Key01Icon} title={credential.name} outcome="Saved" />
    );

  if (!request)
    return (
      <SettledCard
        icon={Key01Icon}
        title={credential.name}
        outcome="Declined"
      />
    );

  return (
    <CredentialPendingCard
      credential={credential}
      request={request}
      botId={botId}
    />
  );
}

function CredentialPendingCard({
  credential,
  request,
  botId,
}: {
  credential: { name: string; hosts: string[] };
  request: { hosts: string[] };
  botId: string;
}) {
  const [value, setValue] = useState("");
  const [expanded, setExpanded] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      call<Credential, { hosts: string[]; value: string }>(
        credentialPath(botId, credential.name),
        "PUT",
        { hosts: request.hosts, value },
      ),
    onSuccess: async () => {
      setValue("");
      await queryClient.invalidateQueries({
        queryKey: credentialsQuery(botId).queryKey,
      });
    },
  });

  const decline = useMutation({
    mutationFn: () =>
      send(`${credentialPath(botId, credential.name)}/decline`, "POST"),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: credentialsQuery(botId).queryKey,
      }),
  });

  const hosts = expanded ? request.hosts : request.hosts.slice(0, 1);

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4">
      <CredentialRequestHeader
        name={credential.name}
        hosts={hosts}
        more={request.hosts.length - 1}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
      <Input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Credential value"
      />
      {(save.isError || decline.isError) && (
        <p className="text-xs text-destructive">
          {(save.error ?? decline.error)?.message}
        </p>
      )}
      <CredentialRequestActions
        onDecline={() => decline.mutate()}
        onSave={() => save.mutate()}
        canSave={Boolean(value)}
        busy={save.isPending || decline.isPending}
      />
    </div>
  );
}

function CredentialRequestHeader({
  name,
  hosts,
  more,
  expanded,
  onToggle,
}: {
  name: string;
  hosts: string[];
  more: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <HugeiconsIcon
        icon={Key01Icon}
        className="mt-0.5 size-4 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{name}</div>
        <div className="flex flex-wrap gap-x-1 text-xs text-muted-foreground">
          {hosts.map((host) => (
            <span key={host}>{host}</span>
          ))}
          {more > 0 && (
            <button type="button" className="underline" onClick={onToggle}>
              {expanded ? "Show less" : `${more} more`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CredentialRequestActions({
  onDecline,
  onSave,
  canSave,
  busy,
}: {
  onDecline: () => void;
  onSave: () => void;
  canSave: boolean;
  busy: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onClick={onDecline} disabled={busy}>
        Decline
      </Button>
      <Button size="sm" onClick={onSave} disabled={!canSave || busy}>
        Save
      </Button>
    </div>
  );
}

function BotRequestCard({
  request,
  botId,
}: {
  request: BotRequest;
  botId: string;
}) {
  const [open, setOpen] = useState(false);
  const [proposalValid, setProposalValid] = useState(false);
  const current = useQuery(botRequestsQuery(botId));
  const live = current.data?.find((item) => item.id === request.id) ?? request;

  const { approve, decline } = useBotRequestMutations(
    botId,
    request.id,
    setOpen,
  );

  if (live.status !== "pending") return <BotRequestSettled request={live} />;

  return (
    <BotPendingCard
      live={live}
      requestId={request.id}
      open={open}
      setOpen={setOpen}
      proposalValid={proposalValid}
      setProposalValid={setProposalValid}
      onApprove={(proposal) => approve.mutate(proposal)}
      onDecline={() => decline.mutate()}
      approvePending={approve.isPending}
      declinePending={decline.isPending}
      approveError={approve.isError ? (approve.error?.message ?? "") : ""}
      declineError={decline.isError ? (decline.error?.message ?? "") : ""}
    />
  );
}

function BotRequestSettled({ request }: { request: BotRequest }) {
  return (
    <SettledCard
      icon={UserGroupIcon}
      title={request.proposal.name}
      outcome={request.status === "approved" ? "Approved" : "Declined"}
      action={
        request.createdAgentId ? (
          <Button
            render={
              <Link
                to="/bots/$botId"
                params={{ botId: request.createdAgentId }}
              />
            }
            size="xs"
            variant="outline"
          >
            Open chat
          </Button>
        ) : undefined
      }
    />
  );
}

function useBotRequestMutations(
  botId: string,
  requestId: string,
  setOpen: (open: boolean) => void,
) {
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: botRequestsQuery(botId).queryKey,
    });

  const approve = useMutation({
    mutationFn: (proposal?: BotInput) =>
      call<{ request: BotRequest; agent: Bot }, { proposal?: BotInput }>(
        `${botRequestPath(botId, requestId)}/approve`,
        "POST",
        proposal ? { proposal } : undefined,
      ),
    onSuccess: ({ agent }) => {
      setOpen(false);
      queryClient.setQueryData<Bot[]>(botsQuery.queryKey, (bots) =>
        !bots || bots.some((bot) => bot.id === agent.id)
          ? bots
          : [...bots, agent],
      );
      void refresh();
      void queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
    },
    onError: refresh,
  });

  const decline = useMutation({
    mutationFn: () =>
      call<BotRequest>(`${botRequestPath(botId, requestId)}/decline`, "POST"),
    onSuccess: refresh,
    onError: refresh,
  });

  return { approve, decline };
}

function BotPendingCard({
  live,
  requestId,
  open,
  setOpen,
  proposalValid,
  setProposalValid,
  onApprove,
  onDecline,
  approvePending,
  declinePending,
  approveError,
  declineError,
}: {
  live: BotRequest;
  requestId: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  proposalValid: boolean;
  setProposalValid: (valid: boolean) => void;
  onApprove: (proposal?: BotInput) => void;
  onDecline: () => void;
  approvePending: boolean;
  declinePending: boolean;
  approveError: string;
  declineError: string;
}) {
  const servers = useQuery(mcpServersQuery);

  const serverNames = new Map(
    (servers.data ?? []).map((server) => [server.id, server.name]),
  );

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4">
      <BotRequestHeader proposal={live.proposal} onEdit={() => setOpen(true)} />
      <p className="text-sm text-muted-foreground">
        {live.proposal.description}
      </p>
      <BotRequestBadges proposal={live.proposal} serverNames={serverNames} />
      {(approveError || declineError) && (
        <p className="text-xs text-destructive">
          {approveError || declineError}
        </p>
      )}
      <BotRequestActions
        onDecline={onDecline}
        onApprove={() => onApprove()}
        busy={approvePending || declinePending}
      />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Edit bot proposal</SheetTitle>
            <SheetDescription>
              Review the proposed bot before approving it.
            </SheetDescription>
          </SheetHeader>
          <BotRequestEditor
            requestId={requestId}
            proposal={live.proposal}
            error={approveError}
            pending={approvePending}
            valid={proposalValid}
            onValidityChange={setProposalValid}
            // SAFETY: BotFields validates and emits the API bot input shape.
            onSubmit={onApprove}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function BotRequestHeader({
  proposal,
  onEdit,
}: {
  proposal: BotRequest["proposal"];
  onEdit: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <BotAvatar
        bot={{ id: proposal.avatar, avatar: proposal.avatar }}
        size={32}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{proposal.name}</div>
        <div className="text-xs text-muted-foreground">
          {proposal.provider} · {proposal.model}
        </div>
      </div>
      <Button variant="ghost" size="icon-xs" title="Edit" onClick={onEdit}>
        <HugeiconsIcon icon={PencilEdit01Icon} />
      </Button>
    </div>
  );
}

function BotRequestBadges({
  proposal,
  serverNames,
}: {
  proposal: BotRequest["proposal"];
  serverNames: Map<string, string>;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {proposal.tools.map((tool) => (
        <Badge key={tool} variant="outline">
          {CAPABILITIES.find((capability) => capability.tool === tool)?.label ??
            tool}
        </Badge>
      ))}
      {proposal.mcpServers.map((server) => (
        <Badge key={server} variant="secondary">
          {serverNames.get(server) ?? server}
        </Badge>
      ))}
    </div>
  );
}

function BotRequestActions({
  onDecline,
  onApprove,
  busy,
}: {
  onDecline: () => void;
  onApprove: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onClick={onDecline} disabled={busy}>
        Decline
      </Button>
      <Button size="sm" onClick={onApprove} disabled={busy}>
        Approve
      </Button>
    </div>
  );
}

function BotRequestEditor({
  requestId,
  proposal,
  error,
  pending,
  valid,
  onValidityChange,
  onSubmit,
}: {
  requestId: string;
  proposal: BotRequest["proposal"];
  error?: string;
  pending: boolean;
  valid: boolean;
  onValidityChange: (valid: boolean) => void;
  onSubmit: NonNullable<ComponentProps<typeof BotFields>["onSubmit"]>;
}) {
  const formId = `bot-request-${requestId}`;

  return (
    <>
      <div className="p-4">
        <BotFields
          formId={formId}
          // SAFETY: Request proposals are validated agent inputs from the server.
          initial={proposal as ComponentProps<typeof BotFields>["initial"]}
          onValidityChange={onValidityChange}
          onSubmit={onSubmit}
        />
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div>
      <SheetFooter>
        <Button type="submit" form={formId} disabled={pending || !valid}>
          Approve
        </Button>
      </SheetFooter>
    </>
  );
}

function JobCard({
  job,
  jobStatus,
  onOpenJob,
}: {
  job: {
    kind: "coding" | "desktop";
    name: string;
    status?: string | undefined;
  };
  jobStatus?: string | undefined;
  onOpenJob?:
    | ((job: { kind: "coding" | "desktop"; name: string }) => void)
    | undefined;
}) {
  const status = jobStatus ?? job.status;
  const working = status === "working" || status === "running";
  const Icon = job.kind === "coding" ? HammerIcon : ComputerIcon;

  return (
    <button
      type="button"
      className="flex w-full max-w-sm items-center gap-3 rounded-xl border p-3 text-left hover:bg-muted/50"
      onClick={() => onOpenJob?.(job)}
    >
      <HugeiconsIcon icon={Icon} className="size-4 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{job.name}</span>
        <span className="text-xs text-muted-foreground">
          {job.kind === "coding" ? "Coding job" : "Desktop job"}
        </span>
      </span>
      {working ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Working
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">Idle</span>
      )}
    </button>
  );
}

export function ToolResultRow({
  message,
  botId,
  jobStatus,
  onOpenJob,
}: {
  message: Message;
  /** The bot whose chat this is; a credential request links to its credentials. */
  botId?: string;
  jobStatus?: string | undefined;
  onOpenJob?: (job: { kind: "coding" | "desktop"; name: string }) => void;
}) {
  const display = displayOf(message);

  if (display) return <DisplayCard display={display} />;

  const credential = credentialRequestOf(message);

  if (credential)
    return botId ? (
      <CredentialRequestCard credential={credential} botId={botId} />
    ) : null;

  const botRequest = botRequestOf(message);

  if (botRequest)
    return botId ? <BotRequestCard request={botRequest} botId={botId} /> : null;

  const job = jobOf(message);

  if (!job) return null;

  return <JobCard job={job} jobStatus={jobStatus} onOpenJob={onOpenJob} />;
}

export function TypingDots() {
  return (
    <div className="flex gap-1 px-3 py-2" aria-label="Working">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 animate-bounce rounded-full bg-bot-strong"
          style={{ animationDelay: `${index * 150}ms` }}
        />
      ))}
    </div>
  );
}

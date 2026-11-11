import { GatewayIcon, gatewayOrigin } from "@/components/gateway-brand";
import { type ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  IconChevronRight,
  IconFileText,
  IconPhone,
  IconKey,
  IconArrowBackUp,
  IconUsersGroup,
} from "@tabler/icons-react";
import { Bubble, BubbleContent, BubbleReactions } from "@/components/ui/bubble";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  Message as MessageRow,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { Message } from "./api";
import { apiBlob } from "@/lib/api";
import { botStyle } from "@/components/bot-avatar";
import type { Upload } from "./composer";
import type { Outgoing } from "./delivery";
import { CopyButton } from "@/components/form-fields";
import { Reply } from "@/components/markdown";
import { reactionDetails } from "@crumble/server/contract/tool-details";
import { REACTION_TOOL_NAME } from "@crumble/server/contract/tools";
import { blocksOf, toolDetailsOf } from "./tool-details";

/** Merges older pages into the live page, dropping IDs they share. Every page is in transcript order, oldest first. */
export function mergeMessages(older: Message[], live: Message[]) {
  const byId = new Map<string, Message>();

  for (const message of [...older, ...live]) byId.set(message.id, message);

  return [...byId.values()];
}

export function hasText(message: Message) {
  if (!Array.isArray(message.blocks)) return message.content.trim() !== "";

  return blocksOf(message).some(
    (block) => block.type === "text" && Boolean(block.text?.trim()),
  );
}

export const hasContent = (message: Message) =>
  message.content.trim() !== "" || Boolean(message.attachments?.length);

export type Reaction = { emoji: string; from?: string | undefined };

/** The entry a reaction answers: bots react to the owner's last message, unless the group's records its target. */
export type ReactionTarget = (
  message: Message,
  lastOwner: string | undefined,
) => string | undefined;

export function reactionsOf(messages: Message[], targetOf: ReactionTarget) {
  const reactions = new Map<string, Reaction[]>();
  let lastOwner: string | undefined;

  for (const message of messages) {
    if (message.role === "user" && message.entryId) lastOwner = message.entryId;

    const reaction = toolDetailsOf(
      message,
      reactionDetails,
      REACTION_TOOL_NAME,
    );

    const target = targetOf(message, lastOwner);

    if (!reaction || !target) continue;

    reactions.set(target, [
      ...(reactions.get(target) ?? []),
      { emoji: reaction.emoji, from: message.origin?.name },
    ]);
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

export function useArrivals(live: Message[] | undefined) {
  const [seen, setSeen] = useState<Set<string> | null>(null);

  if (live && !seen) setSeen(new Set(live.map((message) => message.id)));

  return {
    remember: (messages: Message[]) =>
      setSeen((current) =>
        current
          ? new Set([...current, ...messages.map((message) => message.id)])
          : current,
      ),
    arrival: (message: Message) =>
      seen &&
      !seen.has(message.id) &&
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

export function CallMarker({
  title,
  quote,
  reactions,
}: {
  title: string;
  quote?: string | undefined;
  reactions?: string | undefined;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Marker className="justify-center">
        <MarkerIcon>
          <IconPhone />
        </MarkerIcon>
        <MarkerContent>{title}</MarkerContent>
        {reactions && <Badge variant="secondary">{reactions}</Badge>}
      </Marker>
      {quote && (
        <blockquote className="max-w-md border-l-2 pl-2 text-sm whitespace-pre-wrap text-muted-foreground">
          {quote}
        </blockquote>
      )}
    </div>
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

export function NoticeRow({
  message,
  reactions,
}: {
  message: Message;
  reactions?: Reaction[] | undefined;
}) {
  if (message.origin?.kind === "call")
    return (
      <CallMarker
        title={message.content}
        reactions={reactions?.map(({ emoji }) => emoji).join("")}
      />
    );

  return (
    <CenteredDisclosure
      title={originLabel(message)}
      content={message.content}
    />
  );
}

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
        <IconChevronRight
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

export function AttachmentImage({
  path,
  name,
  className,
}: {
  path: string;
  name: string;
  className?: string;
}) {
  const image = useQuery({
    queryKey: ["attachment", path],
    queryFn: ({ signal }) => apiBlob(path, signal),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });

  const [objectUrl, setObjectUrl] = useState<{ blob: Blob; url: string }>();

  useEffect(() => {
    if (!image.data) return;

    const url = URL.createObjectURL(image.data);
    setObjectUrl({ blob: image.data, url });

    return () => URL.revokeObjectURL(url);
  }, [image.data]);

  return objectUrl && objectUrl.blob === image.data ? (
    <img
      src={objectUrl.url}
      alt={name}
      className={cn(
        "max-h-64 max-w-full rounded-lg object-contain outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10",
        className,
      )}
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
      {message.attachments.map((attachment, index) => {
        const path = attachmentPath(message.entryId, index);

        return attachment.kind === "image" ? (
          <AttachmentImage key={path} name={attachment.name} path={path} />
        ) : (
          <Badge key={path} variant="outline">
            <IconFileText data-icon="inline-start" />
            {attachment.name}
          </Badge>
        );
      })}
    </div>
  );
}

function originLabel(message: Message) {
  const origin = message.origin;

  if (!origin) return null;

  if (origin.kind === "bot_request") return "Bot request";

  if (origin.kind === "call_request") return "Call request";

  if (origin.kind === "call") return "Call";

  return originContent(origin);
}

function automationOrigin(origin: NonNullable<Message["origin"]>) {
  const name = origin.name ?? "";

  if (origin.kind === "task") return `Automation · ${name}`;

  if (origin.kind === "event")
    return `Automation · ${name}, event from ${origin.source ?? "a deleted source"}`;

  return origin.kind === "script" ? `Script automation · ${name}` : null;
}

function originContent(origin: NonNullable<Message["origin"]>) {
  const automation = automationOrigin(origin);

  if (automation) return automation;

  if (origin.kind === "credential")
    return (
      <span className="flex items-center gap-1">
        <IconKey className="size-3" />
        Credential · {origin.name}
      </span>
    );

  if (origin.kind === "bot")
    return (
      <span className="flex items-center gap-1">
        <IconUsersGroup className="size-3" />
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
    <div className="flex gap-1 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
      {canReply && (
        <Button
          variant="ghost"
          size="icon-xs"
          title="Reply"
          onClick={() => onReply(message)}
        >
          <IconArrowBackUp />
        </Button>
      )}
      <CopyButton text={message.content} size="icon-xs" />
    </div>
  );
}

function MessageReactions({
  reactions,
  align,
}: {
  reactions: Reaction[] | undefined;
  align: "start" | "end";
}) {
  if (!reactions || reactions.length === 0) return null;

  return (
    <BubbleReactions side="bottom" align={align}>
      <Badge
        variant="secondary"
        title={reactions
          .map(({ emoji, from }) => (from ? `${from} ${emoji}` : emoji))
          .join(", ")}
      >
        {reactions.map(({ emoji }) => emoji).join("")}
      </Badge>
    </BubbleReactions>
  );
}

export type Delivery = Outgoing["state"];

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
  uploads?: Upload[];
  quote?: string | undefined;
  reactions?: Reaction[] | undefined;
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
  reactions?: Reaction[] | undefined;
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

  // A sent message's uploads never change.
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {uploads.map((upload, index) =>
        upload.preview ? (
          <img
            // react-doctor-disable-next-line no-array-index-as-key
            key={index}
            src={upload.preview}
            alt={upload.name}
            className="max-h-64 max-w-full rounded-lg object-contain"
          />
        ) : (
          // react-doctor-disable-next-line no-array-index-as-key
          <Badge key={index} variant="outline">
            <IconFileText data-icon="inline-start" />
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
  reactions?: Reaction[] | undefined;
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
      {message.origin?.via && (
        <span className="flex items-center gap-1 [&_svg]:size-3">
          <GatewayIcon id={message.origin.via} />
          {gatewayOrigin(message.origin.via)}
        </span>
      )}
    </MessageFooter>
  );
}

export function BotMessage({
  message,
  sender,
  color,
  reactions,
  onReply,
}: {
  message: Message;
  sender?: ReactNode;
  color?: string | undefined;
  reactions?: Reaction[] | undefined;
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
              <Reply
                source={message.presentation?.text ?? message.content}
                citations={message.presentation?.citations}
              />
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

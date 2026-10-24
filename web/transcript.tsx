import { type ReactNode, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  ArrowUp02Icon,
  Attachment01Icon,
  Cancel01Icon,
  ComputerIcon,
  Copy01Icon,
  File02Icon,
  HammerIcon,
  Key01Icon,
  ReplyIcon,
  StopIcon,
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type Bot, type Message, blobUrl } from "./api";
import { botStyle } from "./avatar";
import { DisplayCard, displayOf } from "./display";
import { Reply } from "./markdown";

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
    | { name?: string; hosts?: string[] }
    | undefined;

  return details?.name
    ? { name: details.name, hosts: details.hosts ?? [] }
    : null;
}

export function shownInChat(message: Message) {
  switch (message.role) {
    case "user":
      return (
        (message.content.trim() !== "" ||
          Boolean(message.attachments?.length)) &&
        message.origin?.kind !== "coding" &&
        message.origin?.kind !== "desktop"
      );
    case "assistant":
      return hasText(message);
    case "toolResult":
      return (
        displayOf(message) !== null ||
        jobOf(message) !== null ||
        credentialRequestOf(message) !== null
      );
    case "event":
      return message.content.trim() !== "";
    default:
      return false;
  }
}

/** Emoji reactions from the `react` tool, keyed by the message they react to. */
export function reactionsOf(messages: Message[], group: boolean) {
  const reactions = new Map<string, string[]>();
  let lastUser: string | undefined;

  for (const message of messages) {
    if (message.role === "user" && message.entryId) lastUser = message.entryId;

    if (message.role !== "toolResult" || message.toolName !== "react") continue;

    if (message.isError) continue;

    // SAFETY: The react tool records the emoji it sent in its details.
    const emoji = (message.toolDetails as { emoji?: string } | undefined)
      ?.emoji;

    const target = group ? message.replyTo : lastUser;

    if (!emoji || !target) continue;

    const label =
      group && message.origin?.name ? `${message.origin.name} ${emoji}` : emoji;

    reactions.set(target, [...(reactions.get(target) ?? []), label]);
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
  const [open, setOpen] = useState(false);
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
        {status && <Badge variant="outline">{status}</Badge>}
      </button>
      {open && (
        <div className="rounded-lg bg-muted/50 p-3 text-sm">
          <Reply source={message.content} />
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

  if (!origin || origin.kind === "owner") return null;

  if (origin.kind === "task") return `Task · ${origin.name ?? ""}`;

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
  onReply?: (message: Message) => void;
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

export type Delivery = "sending" | "failed";

/** An owner message: right-aligned bubble with origin, reply quote, attachments, reactions, and delivery state. */
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
  quote?: string;
  reactions?: string[];
  delivery?: Delivery;
  onRetry?: () => void;
  onReply?: (message: Message) => void;
  attachmentPath: (entryId: string, index: number) => string;
}) {
  const label = originLabel(message);

  return (
    <MessageRow align="end">
      <MessageContent>
        {label && <MessageHeader>{label}</MessageHeader>}
        {quote && (
          <div className="line-clamp-2 self-end border-r-2 pr-2 text-xs text-muted-foreground">
            {quote}
          </div>
        )}
        <Attachments message={message} attachmentPath={attachmentPath} />
        {uploads && uploads.length > 0 && (
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
        )}
        {message.content.trim() && (
          <Bubble variant="secondary" align="end">
            <BubbleContent className="whitespace-pre-wrap">
              {message.content}
            </BubbleContent>
            {reactions && reactions.length > 0 && (
              <BubbleReactions side="bottom" align="end">
                <Badge variant="secondary" title={reactions.join(", ")}>
                  {reactions
                    .map((reaction) => reaction.split(" ").at(-1))
                    .join("")}
                </Badge>
              </BubbleReactions>
            )}
          </Bubble>
        )}
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
          {!delivery && <MessageActions message={message} onReply={onReply} />}
        </MessageFooter>
      </MessageContent>
    </MessageRow>
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
  color?: string;
  reactions?: string[];
  onReply?: (message: Message) => void;
}) {
  return (
    <MessageRow align="start">
      <MessageContent>
        {sender && <MessageHeader>{sender}</MessageHeader>}
        <Bubble
          variant="secondary"
          className="*:data-[slot=bubble-content]:bg-bot-soft!"
          style={color ? botStyle(color) : undefined}
        >
          <BubbleContent>
            <Reply source={message.content} />
          </BubbleContent>
          {reactions && reactions.length > 0 && (
            <BubbleReactions side="bottom" align="start">
              <Badge variant="secondary" title={reactions.join(", ")}>
                {reactions
                  .map((reaction) => reaction.split(" ").at(-1))
                  .join("")}
              </Badge>
            </BubbleReactions>
          )}
        </Bubble>
        <MessageFooter>
          <MessageActions message={message} onReply={onReply} />
        </MessageFooter>
      </MessageContent>
    </MessageRow>
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
  jobStatus?: string;
  onOpenJob?: (job: { kind: "coding" | "desktop"; name: string }) => void;
}) {
  const display = displayOf(message);

  if (display) return <DisplayCard display={display} />;

  const credential = credentialRequestOf(message);

  if (credential)
    return botId ? (
      <Link
        to="/bots/$botId/credentials"
        params={{ botId }}
        className="flex w-full max-w-sm items-center gap-3 rounded-xl border p-3 text-left hover:bg-muted/50"
      >
        <HugeiconsIcon
          icon={Key01Icon}
          className="size-4 text-muted-foreground"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {credential.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            Credential request · {credential.hosts.join(", ")}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">Review</span>
      </Link>
    ) : null;

  const job = jobOf(message);

  if (!job) return null;

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

export type Upload = {
  name: string;
  mimeType: string;
  data: string;
  preview?: string;
};

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_TEXT = 512 * 1024;
const MAX_FILES = 8;

function base64(bytes: ArrayBuffer) {
  let binary = "";
  const view = new Uint8Array(bytes);

  for (let index = 0; index < view.length; index += 0x8000)
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000));

  return btoa(binary);
}

/** Re-encodes other or oversized images as JPEG within 2048 pixels, like the native apps. */
async function reencode(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));

  const canvas = new OffscreenCanvas(
    Math.round(bitmap.width * scale),
    Math.round(bitmap.height * scale),
  );

  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

/** Turns picked files into message attachments, enforcing the server's limits. */
export async function toUploads(files: File[]) {
  const uploads: Upload[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      if (file.type.startsWith("image/")) {
        const direct =
          IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE;

        const blob = direct ? file : await reencode(file);

        if (blob.size > MAX_IMAGE) {
          errors.push(`${file.name} is larger than 5 MB.`);
          continue;
        }

        uploads.push({
          name: direct ? file.name : file.name.replace(/\.[^.]+$/, "") + ".jpg",
          mimeType: blob.type,
          data: base64(await blob.arrayBuffer()),
          preview: URL.createObjectURL(blob),
        });
        continue;
      }

      const bytes = await file.arrayBuffer();

      if (bytes.byteLength > MAX_TEXT) {
        errors.push(`${file.name} is larger than 512 KB.`);
        continue;
      }

      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      uploads.push({
        name: file.name,
        mimeType:
          file.type.startsWith("text/") || file.type === "application/json"
            ? file.type
            : "text/plain",
        data: base64(bytes),
      });
    } catch {
      errors.push(
        `${file.name} can't be attached. Attach images or text files.`,
      );
    }
  }

  return { uploads, errors };
}

export type Mentionable = Pick<Bot, "id" | "name">;

export function Composer({
  placeholder,
  disabled,
  running,
  replyingTo,
  onCancelReply,
  mentionable = [],
  actions,
  onSend,
  onStop,
}: {
  placeholder: string;
  disabled?: boolean;
  running: boolean;
  replyingTo?: string;
  onCancelReply?: () => void;
  mentionable?: Mentionable[];
  /** Controls shown beside the send button. */
  actions?: ReactNode;
  onSend: (content: string, uploads: Upload[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => field.current?.focus(), []);

  const mention = /(?:^|\s)@([^\s@]*)$/.exec(draft)?.[1];

  const suggestions =
    mention === undefined
      ? []
      : mentionable.filter((bot) =>
          bot.name.toLowerCase().startsWith(mention.toLowerCase()),
        );

  const [selected, setSelected] = useState(0);
  const suggestion = suggestions[selected % Math.max(suggestions.length, 1)];

  const accept = () => {
    if (!suggestion || mention === undefined) return;

    setDraft(
      `${draft.slice(0, draft.length - mention.length)}${suggestion.name} `,
    );
    setSelected(0);
  };

  const add = async (files: File[]) => {
    const room = MAX_FILES - uploads.length;

    const { uploads: added, errors: failed } = await toUploads(
      files.slice(0, room),
    );

    setUploads([...uploads, ...added]);
    setErrors([
      ...failed,
      ...(files.length > room ? [`Attach at most ${MAX_FILES} files.`] : []),
    ]);
  };

  const canSend =
    !disabled && !sending && (draft.trim() !== "" || uploads.length > 0);

  const submit = async () => {
    if (!canSend) return;

    setSending(true);
    const content = draft.trim();
    const pending = uploads;

    setDraft("");
    setUploads([]);
    setErrors([]);

    // A failed send puts the message back when nothing new was typed.
    if (!(await onSend(content, pending))) {
      setDraft((current) => current || content);
      setUploads((current) => (current.length ? current : pending));
    }

    setSending(false);
  };

  return (
    <form
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col gap-2 p-4",
        dragging && "rounded-xl outline-2 outline-dashed outline-ring",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        if (disabled) return;

        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);

        if (!disabled) void add([...event.dataTransfer.files]);
      }}
    >
      {replyingTo && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <HugeiconsIcon icon={ReplyIcon} className="size-3" />
          <span className="truncate">Replying to {replyingTo}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Cancel reply"
            onClick={onCancelReply}
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        </div>
      )}
      {uploads.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {uploads.map((upload, index) => (
            <Badge key={index} variant="outline" className="h-8 gap-1.5 pr-0.5">
              {upload.preview ? (
                <img
                  src={upload.preview}
                  alt=""
                  className="size-6 rounded object-cover"
                />
              ) : (
                <HugeiconsIcon icon={File02Icon} data-icon="inline-start" />
              )}
              <span className="max-w-40 truncate">{upload.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                title={`Remove ${upload.name}`}
                onClick={() =>
                  setUploads(uploads.filter((_, other) => other !== index))
                }
              >
                <HugeiconsIcon icon={Cancel01Icon} />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      {errors.map((error) => (
        <p key={error} className="text-xs text-destructive">
          {error}
        </p>
      ))}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1 text-xs">
          {suggestions.map((bot, index) => (
            <Button
              key={bot.id}
              type="button"
              size="xs"
              variant={bot === suggestion ? "secondary" : "ghost"}
              onClick={() => {
                setSelected(index);
                setDraft(
                  `${draft.slice(0, draft.length - (mention?.length ?? 0))}${bot.name} `,
                );
              }}
            >
              @{bot.name}
            </Button>
          ))}
          <span className="self-center text-muted-foreground">
            Tab to complete
          </span>
        </div>
      )}
      <div
        className={cn(
          "flex items-end gap-1 rounded-3xl border border-input bg-background p-1.5 shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-bot focus-within:shadow-sm dark:bg-input/30",
          disabled && "opacity-50",
        )}
      >
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept="image/*,text/*,.json,.xml,.md,.csv,.ts,.tsx,.js,.py,.swift,.go,.rs,.java,.kt,.rb,.sh,.yaml,.yml,.toml"
          onChange={(event) => {
            void add([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          title="Attach files"
          disabled={disabled || uploads.length >= MAX_FILES}
          onClick={() => picker.current?.click()}
        >
          <HugeiconsIcon icon={Attachment01Icon} />
        </Button>
        <Textarea
          ref={field}
          aria-label="Message"
          placeholder={placeholder}
          disabled={disabled}
          className="max-h-[40vh] min-h-8 resize-none self-center border-0 bg-transparent px-1.5 py-1.5 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSelected(0);
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];

            if (files.length) {
              event.preventDefault();
              void add(files);
            }
          }}
          onKeyDown={(event) => {
            if (suggestions.length && event.key === "Tab") {
              event.preventDefault();
              accept();
            } else if (suggestions.length && event.key === "ArrowDown") {
              event.preventDefault();
              setSelected(selected + 1);
            } else if (suggestions.length && event.key === "ArrowUp") {
              event.preventDefault();
              setSelected(selected + suggestions.length - 1);
            } else if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.altKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {actions}
        {running && (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="rounded-full"
            title="Stop"
            onClick={onStop}
          >
            <HugeiconsIcon icon={StopIcon} />
          </Button>
        )}
        {(!running || canSend) && (
          <Button
            type="submit"
            size="icon"
            className="rounded-full bg-bot-strong hover:bg-bot-strong hover:brightness-110"
            title="Send"
            disabled={!canSend}
          >
            <HugeiconsIcon icon={ArrowUp02Icon} />
          </Button>
        )}
      </div>
    </form>
  );
}

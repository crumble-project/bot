import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp02Icon,
  Attachment01Icon,
  Cancel01Icon,
  File02Icon,
  ReplyIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Bot } from "@/lib/api";

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

type UploadResult = { upload: Upload } | { error: string };

async function imageUpload(file: File): Promise<UploadResult> {
  const direct = IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE;
  const blob = direct ? file : await reencode(file);

  if (blob.size > MAX_IMAGE)
    return { error: `${file.name} is larger than 5 MB.` };

  return {
    upload: {
      name: direct ? file.name : file.name.replace(/\.[^.]+$/, "") + ".jpg",
      mimeType: blob.type,
      data: base64(await blob.arrayBuffer()),
      preview: URL.createObjectURL(blob),
    },
  };
}

async function textUpload(file: File): Promise<UploadResult> {
  const bytes = await file.arrayBuffer();

  if (bytes.byteLength > MAX_TEXT)
    return { error: `${file.name} is larger than 512 KB.` };

  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  return {
    upload: {
      name: file.name,
      mimeType:
        file.type.startsWith("text/") || file.type === "application/json"
          ? file.type
          : "text/plain",
      data: base64(bytes),
    },
  };
}

/** Turns picked files into message attachments, enforcing the server's limits. */
export async function toUploads(files: File[]) {
  const uploads: Upload[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const result = await (file.type.startsWith("image/")
        ? imageUpload(file)
        : textUpload(file));

      if ("error" in result) errors.push(result.error);
      else uploads.push(result.upload);
    } catch {
      errors.push(
        `${file.name} can't be attached. Attach images or text files.`,
      );
    }
  }

  return { uploads, errors };
}

export type Mentionable = Pick<Bot, "id" | "name">;

function useAttachments() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

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

  return { uploads, setUploads, errors, setErrors, add };
}

function useMentions(
  draft: string,
  setDraft: (draft: string) => void,
  mentionable: Mentionable[],
) {
  const [selected, setSelected] = useState(0);
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(draft)?.[1];

  const suggestions =
    mention === undefined
      ? []
      : mentionable.filter((bot) =>
          bot.name.toLowerCase().startsWith(mention.toLowerCase()),
        );

  const suggestion = suggestions[selected % Math.max(suggestions.length, 1)];

  const accept = () => {
    if (!suggestion || mention === undefined) return;

    setDraft(
      `${draft.slice(0, draft.length - mention.length)}${suggestion.name} `,
    );
    setSelected(0);
  };

  const pick = (bot: Mentionable, index: number) => {
    setSelected(index);
    setDraft(
      `${draft.slice(0, draft.length - (mention?.length ?? 0))}${bot.name} `,
    );
  };

  const navigate = (event: KeyboardEvent) => {
    if (!suggestions.length) return false;

    if (event.key === "Tab") accept();
    else if (event.key === "ArrowDown") setSelected(selected + 1);
    else if (event.key === "ArrowUp")
      setSelected(selected + suggestions.length - 1);
    else return false;

    event.preventDefault();

    return true;
  };

  return {
    suggestions,
    suggestion,
    reset: () => setSelected(0),
    pick,
    navigate,
  };
}

function isSubmitKey(event: KeyboardEvent) {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.nativeEvent.isComposing
  );
}

function useDropTarget(
  disabled: boolean | undefined,
  add: (files: File[]) => void,
) {
  const [dragging, setDragging] = useState(false);

  return {
    dragging,
    onDragOver: (event: DragEvent) => {
      if (disabled) return;

      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);

      if (!disabled) add([...event.dataTransfer.files]);
    },
  };
}

function ReplyBanner({
  replyingTo,
  onCancel,
}: {
  replyingTo: string | undefined;
  onCancel?: (() => void) | undefined;
}) {
  if (!replyingTo) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <HugeiconsIcon icon={ReplyIcon} className="size-3" />
      <span className="truncate">Replying to {replyingTo}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="Cancel reply"
        onClick={onCancel}
      >
        <HugeiconsIcon icon={Cancel01Icon} />
      </Button>
    </div>
  );
}

function UploadChips({
  uploads,
  onRemove,
}: {
  uploads: Upload[];
  onRemove: (index: number) => void;
}) {
  if (uploads.length === 0) return null;

  return (
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
            onClick={() => onRemove(index)}
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        </Badge>
      ))}
    </div>
  );
}

function MentionSuggestions({
  suggestions,
  suggestion,
  onPick,
}: {
  suggestions: Mentionable[];
  suggestion: Mentionable | undefined;
  onPick: (bot: Mentionable, index: number) => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 text-xs">
      {suggestions.map((bot, index) => (
        <Button
          key={bot.id}
          type="button"
          size="xs"
          variant={bot === suggestion ? "secondary" : "ghost"}
          onClick={() => onPick(bot, index)}
        >
          @{bot.name}
        </Button>
      ))}
      <span className="self-center text-muted-foreground">Tab to complete</span>
    </div>
  );
}

function AttachControl({
  disabled,
  full,
  onFiles,
}: {
  disabled: boolean | undefined;
  full: boolean;
  onFiles: (files: File[]) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        accept="image/*,text/*,.json,.xml,.md,.csv,.ts,.tsx,.js,.py,.swift,.go,.rs,.java,.kt,.rb,.sh,.yaml,.yml,.toml"
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="rounded-full"
        title="Attach files"
        disabled={disabled || full}
        onClick={() => picker.current?.click()}
      >
        <HugeiconsIcon icon={Attachment01Icon} />
      </Button>
    </>
  );
}

function SendControls({
  running,
  canSend,
  onStop,
}: {
  running: boolean;
  canSend: boolean;
  onStop: () => void;
}) {
  return (
    <>
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
    </>
  );
}

function pasteFiles(event: ClipboardEvent, add: (files: File[]) => void) {
  const files = [...event.clipboardData.files];

  if (files.length) {
    event.preventDefault();
    add(files);
  }
}

function canSendDraft(
  disabled: boolean | undefined,
  sending: boolean,
  draft: string,
  uploads: Upload[],
) {
  return !disabled && !sending && (draft.trim() !== "" || uploads.length > 0);
}

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
  replyingTo?: string | undefined;
  onCancelReply?: () => void;
  mentionable?: Mentionable[];
  /** Controls shown beside the send button. */
  actions?: ReactNode;
  onSend: (content: string, uploads: Upload[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const { uploads, setUploads, errors, setErrors, add } = useAttachments();
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions(draft, setDraft, mentionable);
  const drop = useDropTarget(disabled, (files) => void add(files));

  useEffect(() => field.current?.focus(), []);

  const canSend = canSendDraft(disabled, sending, draft, uploads);

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
        "mx-auto flex w-full max-w-3xl flex-col gap-2 p-4 pb-[max(--spacing(4),env(safe-area-inset-bottom))]",
        drop.dragging && "rounded-xl outline-2 outline-dashed outline-ring",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      <ReplyBanner replyingTo={replyingTo} onCancel={onCancelReply} />
      <UploadChips
        uploads={uploads}
        onRemove={(index) =>
          setUploads(uploads.filter((_, other) => other !== index))
        }
      />
      {errors.map((error) => (
        <p key={error} className="text-xs text-destructive">
          {error}
        </p>
      ))}
      <MentionSuggestions
        suggestions={mentions.suggestions}
        suggestion={mentions.suggestion}
        onPick={mentions.pick}
      />
      <div
        className={cn(
          "flex items-end gap-1 rounded-3xl border border-input bg-background p-1.5 shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-bot focus-within:shadow-sm dark:bg-input/30",
          disabled && "opacity-50",
        )}
      >
        <AttachControl
          disabled={disabled}
          full={uploads.length >= MAX_FILES}
          onFiles={(files) => void add(files)}
        />
        <Textarea
          ref={field}
          aria-label="Message"
          placeholder={placeholder}
          disabled={disabled}
          className="max-h-[40vh] min-h-8 resize-none self-center border-0 bg-transparent px-1.5 py-1.5 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            mentions.reset();
          }}
          onPaste={(event) => pasteFiles(event, (files) => void add(files))}
          onKeyDown={(event) => {
            if (mentions.navigate(event) || !isSubmitKey(event)) return;

            event.preventDefault();
            void submit();
          }}
        />
        {actions}
        <SendControls running={running} canSend={canSend} onStop={onStop} />
      </div>
    </form>
  );
}

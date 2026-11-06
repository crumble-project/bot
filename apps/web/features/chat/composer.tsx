import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  IconArrowUp,
  IconPaperclip,
  IconPlus,
  IconX,
  IconFileText,
  IconArrowBackUp,
  IconPlayerStop,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { readDraft, saveDraft } from "./drafts";
import { cn, randomId } from "@/lib/utils";
import type { Bot } from "@/features/bots/api";
import {
  attachmentKind,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
} from "@crumble/server/contract/limits";

export type Upload = {
  name: string;
  mimeType: string;
  data: string;
  preview?: string;
};

const uploadKeys = new WeakMap<Upload, string>();

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
  const direct =
    attachmentKind(file.type) === "image" && file.size <= MAX_IMAGE_BYTES;

  const blob = direct ? file : await reencode(file);

  if (blob.size > MAX_IMAGE_BYTES)
    return {
      error: `${file.name} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
    };

  const data = base64(await blob.arrayBuffer());

  return {
    upload: {
      name: direct ? file.name : file.name.replace(/\.[^.]+$/, "") + ".jpg",
      mimeType: blob.type,
      data,
      preview: `data:${blob.type};base64,${data}`,
    },
  };
}

async function textUpload(file: File): Promise<UploadResult> {
  const bytes = await file.arrayBuffer();

  if (bytes.byteLength > MAX_TEXT_BYTES)
    return {
      error: `${file.name} is larger than ${MAX_TEXT_BYTES / 1024} KB.`,
    };

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

export async function toUploads(files: File[]) {
  const uploads: Upload[] = [];
  const errors: string[] = [];

  const results = await Promise.all(
    files.map((file) =>
      (file.type.startsWith("image/")
        ? imageUpload(file)
        : textUpload(file)
      ).catch(() => ({
        error: `${file.name} can't be attached. Attach images or text files.`,
      })),
    ),
  );

  for (const result of results) {
    if ("error" in result) errors.push(result.error);
    else {
      uploadKeys.set(result.upload, randomId());
      uploads.push(result.upload);
    }
  }

  return { uploads, errors };
}

export type Mentionable = Pick<Bot, "id" | "name">;

function useAttachments() {
  const [state, setState] = useState<{ uploads: Upload[]; errors: string[] }>({
    uploads: [],
    errors: [],
  });

  const recovery = useRef(0);

  const setUploads = (update: (uploads: Upload[]) => Upload[]) =>
    setState((current) => ({ ...current, uploads: update(current.uploads) }));

  const setErrors = (errors: string[]) =>
    setState((current) => ({ ...current, errors }));

  const restore = (pending: Upload[]) => {
    recovery.current++;
    setUploads((current) => [...pending, ...current]);
  };

  const add = async (files: File[]) => {
    const started = recovery.current;

    const { uploads: added, errors: failed } = await toUploads(
      files.slice(0, MAX_ATTACHMENTS),
    );

    setState((current) => {
      const room =
        started === recovery.current
          ? Math.max(0, MAX_ATTACHMENTS - current.uploads.length)
          : MAX_ATTACHMENTS;

      return {
        uploads: [...current.uploads, ...added.slice(0, room)],
        errors: [
          ...failed,
          ...(files.length > room
            ? [`Attach at most ${MAX_ATTACHMENTS} files.`]
            : []),
        ],
      };
    });
  };

  return { ...state, setUploads, setErrors, add, restore };
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
    else if (event.key === "ArrowDown") setSelected((current) => current + 1);
    else if (event.key === "ArrowUp")
      setSelected((current) => current + suggestions.length - 1);
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
      <IconArrowBackUp className="size-3" />
      <span className="truncate">Replying to {replyingTo}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="Cancel reply"
        onClick={onCancel}
      >
        <IconX />
      </Button>
    </div>
  );
}

export function UploadChips({
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
        <Badge
          key={uploadKeys.get(upload)}
          variant="outline"
          className="h-8 gap-1.5 rounded-full bg-background p-1 pl-2.5 has-[img]:pl-1"
        >
          {upload.preview ? (
            <img
              src={upload.preview}
              alt=""
              className="size-6 rounded-full object-cover"
            />
          ) : (
            <IconFileText data-icon="inline-start" />
          )}
          <span className="max-w-40 truncate">{upload.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-full"
            title={`Remove ${upload.name}`}
            onClick={() => onRemove(index)}
          >
            <IconX />
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-full text-muted-foreground hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
              title="Add"
              disabled={disabled}
            />
          }
        >
          <IconPlus />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-auto min-w-48 rounded-[20px] p-1.5"
        >
          <DropdownMenuItem
            disabled={full}
            className="gap-2.5 rounded-[14px] px-3 py-2 text-[0.9375rem]"
            onClick={() => picker.current?.click()}
          >
            <IconPaperclip className="text-muted-foreground" />
            {full ? `At most ${MAX_ATTACHMENTS} files` : "Attach files"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
          <IconPlayerStop />
        </Button>
      )}
      {(!running || canSend) && (
        <Button
          type="submit"
          size="icon"
          className="rounded-full bg-bot-strong shadow-sm transition-[background-color,box-shadow,scale] duration-150 hover:bg-bot-strong hover:brightness-110 active:scale-90 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none"
          title="Send"
          disabled={!canSend}
        >
          <IconArrowUp />
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
  return (
    !disabled &&
    !sending &&
    uploads.length <= MAX_ATTACHMENTS &&
    (draft.trim() !== "" || uploads.length > 0)
  );
}

function ComposerErrors({
  uploads,
  errors,
}: {
  uploads: number;
  errors: string[];
}) {
  return (
    <>
      {uploads > MAX_ATTACHMENTS && (
        <p className="text-xs text-destructive">
          Attach at most {MAX_ATTACHMENTS} files. Remove{" "}
          {uploads - MAX_ATTACHMENTS} to send.
        </p>
      )}
      {errors.map((error) => (
        <p key={error} className="text-xs text-destructive">
          {error}
        </p>
      ))}
    </>
  );
}

const submitOnEnter =
  (navigate: (event: KeyboardEvent) => boolean, submit: () => Promise<void>) =>
  (event: KeyboardEvent) => {
    if (navigate(event) || !isSubmitKey(event)) return;

    event.preventDefault();
    void submit();
  };

async function sendDraft(
  onSend: (content: string, uploads: Upload[]) => Promise<boolean>,
  content: string,
  uploads: Upload[],
) {
  try {
    return await onSend(content, uploads);
  } catch {
    return false;
  }
}

function MessageField({
  field,
  expanded,
  placeholder,
  disabled,
  value,
  onChange,
  onPaste,
  onKeyDown,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  expanded: boolean;
  placeholder: string;
  disabled: boolean | undefined;
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <Textarea
      ref={field}
      aria-label="Message"
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        "max-h-[40vh] resize-none border-0 bg-transparent text-base leading-6 shadow-none [grid-area:text] focus-visible:ring-0 disabled:bg-transparent md:text-[0.9375rem] dark:bg-transparent dark:disabled:bg-transparent",
        expanded ? "min-h-11 px-3 pt-2 pb-1" : "min-h-8 px-1.5 py-1",
      )}
      value={value}
      onChange={onChange}
      onPaste={onPaste}
      onKeyDown={onKeyDown}
    />
  );
}

const ONE_ROW_PX = 36;

function useExpanded(draft: string) {
  const [wrapped, setWrapped] = useState(false);

  if (wrapped && !draft) setWrapped(false);

  const expanded = draft.includes("\n") || (wrapped && draft !== "");

  // Measured while the field is still one row, before this change re-renders it.
  const measure = (element: HTMLTextAreaElement | null) => {
    if (element?.value && !expanded && element.scrollHeight > ONE_ROW_PX)
      setWrapped(true);
  };

  return { expanded, measure };
}

function focusAtEnd(field: HTMLTextAreaElement | null) {
  if (!field) return;

  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}

function useDraft(chat: string) {
  const [draft, setDraft] = useState(() => readDraft(chat));

  useEffect(() => saveDraft(chat, draft), [chat, draft]);

  return [draft, setDraft] as const;
}

function useMessageField(draftKey: string) {
  const [draft, setDraft] = useDraft(draftKey);
  const field = useRef<HTMLTextAreaElement>(null);
  const { expanded, measure } = useExpanded(draft);

  const restore = useEffectEvent(() => {
    focusAtEnd(field.current);
    measure(field.current);
  });

  useEffect(() => restore(), []);

  return { draft, setDraft, field, expanded, measure };
}

type ComposerProps = {
  draftKey: string;
  placeholder: string;
  disabled?: boolean;
  running: boolean;
  replyingTo?: string | undefined;
  onCancelReply?: () => void;
  mentionable?: Mentionable[];
  actions?: ReactNode;
  onSend: (content: string, uploads: Upload[]) => Promise<boolean>;
  onStop: () => void;
};

function useComposer(
  draftKey: string,
  disabled: boolean | undefined,
  mentionable: Mentionable[],
  onSend: ComposerProps["onSend"],
) {
  const { draft, setDraft, field, expanded, measure } =
    useMessageField(draftKey);

  const { uploads, setUploads, errors, setErrors, add, restore } =
    useAttachments();

  const [sending, setSending] = useState(false);
  const mentions = useMentions(draft, setDraft, mentionable);
  const drop = useDropTarget(disabled, (files) => void add(files));

  const canSend = canSendDraft(disabled, sending, draft, uploads);

  const submit = async () => {
    if (!canSend) return;

    setSending(true);
    const content = draft.trim();
    const pending = uploads;

    setDraft("");
    setUploads(() => []);
    setErrors([]);

    const sent = await sendDraft(onSend, content, pending);

    setSending(false);

    if (sent) return;

    setDraft((current) => [draft, current].filter(Boolean).join("\n"));
    restore(pending);
  };

  const removeUpload = (index: number) =>
    setUploads((current) => current.filter((_, other) => other !== index));

  return {
    draft,
    setDraft,
    field,
    expanded,
    measure,
    uploads,
    removeUpload,
    errors,
    add,
    mentions,
    drop,
    canSend,
    submit,
  };
}

function ComposerCard({
  state,
  placeholder,
  disabled,
  actions,
  running,
  onStop,
}: {
  state: ReturnType<typeof useComposer>;
  placeholder: string;
  disabled: boolean | undefined;
  actions: ReactNode;
  running: boolean;
  onStop: () => void;
}) {
  const { uploads, add, mentions, submit } = state;

  return (
    <div className="composer-card flex flex-col gap-1 rounded-[25px] p-2 has-disabled:opacity-50">
      <UploadChips uploads={uploads} onRemove={state.removeUpload} />
      <div
        data-expanded={state.expanded || undefined}
        className="grid grid-cols-[auto_1fr_auto] items-center gap-x-1 gap-y-1 [grid-template-areas:'attach_text_send'] data-expanded:[grid-template-areas:'text_text_text'_'attach_._send']"
      >
        <MessageField
          field={state.field}
          expanded={state.expanded}
          placeholder={placeholder}
          disabled={disabled}
          value={state.draft}
          onChange={(event) => {
            state.setDraft(event.target.value);
            state.measure(event.target);
            mentions.reset();
          }}
          onPaste={(event) => pasteFiles(event, (files) => void add(files))}
          onKeyDown={submitOnEnter(mentions.navigate, submit)}
        />
        <div className="[grid-area:attach]">
          <AttachControl
            disabled={disabled}
            full={uploads.length >= MAX_ATTACHMENTS}
            onFiles={(files) => void add(files)}
          />
        </div>
        <div className="flex items-center gap-1.5 [grid-area:send]">
          {actions}
          <SendControls
            running={running}
            canSend={state.canSend}
            onStop={onStop}
          />
        </div>
      </div>
    </div>
  );
}

export function Composer({
  draftKey,
  placeholder,
  disabled,
  running,
  replyingTo,
  onCancelReply,
  mentionable = [],
  actions,
  onSend,
  onStop,
}: ComposerProps) {
  const state = useComposer(draftKey, disabled, mentionable, onSend);
  const { uploads, errors, mentions, drop, submit } = state;

  return (
    <form
      className={cn(
        "mx-auto flex w-full max-w-4xl flex-col gap-2 p-4 pb-[max(--spacing(4),env(safe-area-inset-bottom))]",
        drop.dragging && "rounded-[41px] outline-2 outline-dashed outline-ring",
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
      <ComposerErrors uploads={uploads.length} errors={errors} />
      <MentionSuggestions
        suggestions={mentions.suggestions}
        suggestion={mentions.suggestion}
        onPick={mentions.pick}
      />
      <ComposerCard
        state={state}
        placeholder={placeholder}
        disabled={disabled}
        actions={actions}
        running={running}
        onStop={onStop}
      />
    </form>
  );
}

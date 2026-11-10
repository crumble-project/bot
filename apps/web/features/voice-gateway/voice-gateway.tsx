import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  IconArrowDown,
  IconArrowUp,
  IconDeviceLandlinePhone,
  IconKey,
  IconPhone,
  IconUser,
} from "@tabler/icons-react";
import { voiceGatewayConfigInput } from "@crumble/server/contract/voice-gateway";
import { randomId } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CopyButton, EditorSheet } from "@/components/form-fields";
import {
  Page,
  RowTile,
  Section,
  SectionEmpty,
  SettingRow,
} from "@/components/page";
import { type Bot, botsQuery } from "@/features/bots/api";
import {
  AddRowButton,
  BotSelect,
  QueryState,
  RemoveRowButton,
  SaveBar,
} from "@/features/message-gateways/message-gateways";
import { call, queryClient, send } from "@/lib/api";
import {
  type VoiceGateway,
  type VoiceGatewayConfig,
  voiceGatewayQuery,
} from "./api";

type DraftLine = {
  id: string;
  username: string;
  botId: string;
  displayName: string;
  callsOwner: boolean;
  callsOthers: boolean;
};

type Draft = {
  enabled: boolean;
  ownerNumbers: { id: string; value: string }[];
  lines: DraftLine[];
};

const draftOf = (config: VoiceGatewayConfig): Draft => ({
  enabled: config.enabled,
  ownerNumbers: config.ownerNumbers.map((value) => ({ id: randomId(), value })),
  lines: config.lines.map((line) => ({
    ...line,
    id: randomId(),
    displayName: line.displayName ?? "",
    callsOthers: line.callsOthers ?? false,
  })),
});

const configOf = (draft: Draft): VoiceGatewayConfig => ({
  enabled: draft.enabled,
  ownerNumbers: draft.ownerNumbers.map((number) => number.value.trim()),
  lines: draft.lines.map(
    ({ username, botId, displayName, callsOwner, callsOthers }) => ({
      username: username.trim(),
      botId,
      displayName: displayName.trim() || null,
      callsOwner,
      callsOthers,
    }),
  ),
});

const refresh = () =>
  queryClient.invalidateQueries({ queryKey: voiceGatewayQuery.queryKey });

const STATUS_LABELS: Record<VoiceGateway["status"], string> = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  error: "Connection error",
};

const UNAVAILABLE_LABELS: Record<
  VoiceGateway["unavailableLines"][number]["reason"],
  { badge: string | null; description: string }
> = {
  botDeleted: {
    badge: "Bot deleted",
    description: "Choose another bot, or remove the line.",
  },
  botDisabled: {
    badge: "Bot disabled",
    description:
      "The voice gateway leaves this line out until the bot is enabled.",
  },
};

type Errors = Record<string, string | undefined>;

type Parsed = ReturnType<typeof voiceGatewayConfigInput.safeParse>;

type Issue = NonNullable<Parsed["error"]>["issues"][number];

const NUMBER_RULE = "Use up to 32 digits, * or #, with an optional + in front.";

const CALLS_OTHERS_HELP =
  "Only for calls to friends and family who know about it and agreed beforehand. The legal situation for calling anyone else is not settled.";

const USERNAME_RULE = "Use up to 64 letters, numbers, or . _ ~ + -";

function lineMessage(issue: Issue, username: string | undefined) {
  const key = String(issue.path[2]);

  if (key === "botId") return "Choose a bot for this line.";

  if (key === "displayName") return "Use at most 64 characters.";

  if (!username) return "Enter the line's SIP username.";

  return issue.code === "custom" ? issue.message : USERNAME_RULE;
}

function issueMessage(issue: Issue, config: VoiceGatewayConfig) {
  const [field, index] = issue.path;

  if (issue.path.length < 2 && issue.code === "too_big")
    return field === "lines"
      ? "Add at most 64 lines."
      : "Add at most 20 numbers.";

  if (issue.path.length < 2) return issue.message;

  const row = Number(index);

  if (field === "ownerNumbers")
    return config.ownerNumbers[row] ? NUMBER_RULE : "Enter a number.";

  return lineMessage(issue, config.lines[row]?.username);
}

function voiceErrors(config: VoiceGatewayConfig, bots: Bot[], parsed: Parsed) {
  const errors: Record<string, string> = {};

  for (const issue of parsed.error?.issues ?? []) {
    const key = issue.path.slice(0, 2).map(String).join(".");

    errors[key] ??= issueMessage(issue, config);
  }

  config.lines.forEach((line, index) => {
    if (line.botId && !bots.some((bot) => bot.id === line.botId))
      errors[`lines.${index}`] ??=
        "The bot was deleted. Choose another bot, or remove the line.";
  });

  return errors;
}

const fieldError = (message: string | undefined) =>
  message && <FieldError>{message}</FieldError>;

type FieldsProps = {
  draft: Draft;
  bots: Bot[];
  errors: Errors;
  gateway: VoiceGateway;
  patch: (next: Partial<Draft>) => void;
};

function StatusBadge({ gateway }: { gateway: VoiceGateway }) {
  if (!gateway.config.enabled) return <Badge variant="outline">Disabled</Badge>;

  return (
    <Badge variant={gateway.status === "error" ? "destructive" : "secondary"}>
      {STATUS_LABELS[gateway.status]}
    </Badge>
  );
}

function ConnectionSection({
  gateway,
  draft,
  patch,
}: Pick<FieldsProps, "gateway" | "draft" | "patch">) {
  return (
    <Section
      title="Connection"
      description="Call your bots from a phone on your telephone system. The voice gateway runs on your network and connects to Crumble."
    >
      <SettingRow
        tile={
          <RowTile>
            <IconPhone />
          </RowTile>
        }
        title={
          <>
            <label htmlFor="voice-gateway-enabled">Voice gateway</label>
            <StatusBadge gateway={gateway} />
          </>
        }
        description={
          gateway.connectedAt &&
          `Connected since ${new Date(gateway.connectedAt).toLocaleString()}`
        }
      >
        <Switch
          id="voice-gateway-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </SettingRow>
      <TokenRow gateway={gateway} />
    </Section>
  );
}

function NumberRow({
  number,
  index,
  count,
  error,
  onChange,
  onMove,
  onRemove,
}: {
  number: Draft["ownerNumbers"][number];
  index: number;
  count: number;
  error: string | undefined;
  onChange: (value: string) => void;
  onMove: (offset: number) => void;
  onRemove: () => void;
}) {
  return (
    <SettingRow
      tile={
        <RowTile>
          <IconUser />
        </RowTile>
      }
      title={
        <Input
          aria-label={`Number ${index + 1}`}
          placeholder="+4930123456"
          value={number.value}
          inputMode="tel"
          autoComplete="off"
          spellCheck={false}
          className="h-8 max-w-48 font-mono"
          aria-invalid={Boolean(error) || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      }
      description={fieldError(error)}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Move up"
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <IconArrowUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Move down"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <IconArrowDown />
      </Button>
      <RemoveRowButton title="Remove number" onClick={onRemove} />
    </SettingRow>
  );
}

function NumbersSection({ draft, errors, patch }: FieldsProps) {
  const numbers = draft.ownerNumbers;

  const move = (index: number, offset: number) => {
    const next = [...numbers];
    const [moved] = next.splice(index, 1);

    if (moved) next.splice(index + offset, 0, moved);
    patch({ ownerNumbers: next });
  };

  return (
    <Section
      title="Your numbers"
      description="A call from one of these numbers reaches a bot as you. Calls from other numbers never reach a bot. A bot that calls you dials the first."
      action={
        <AddRowButton
          label="Number"
          onClick={() =>
            patch({ ownerNumbers: [...numbers, { id: randomId(), value: "" }] })
          }
        />
      }
    >
      {numbers.length === 0 && <SectionEmpty>No numbers yet.</SectionEmpty>}
      {numbers.map((number, index) => (
        <NumberRow
          key={number.id}
          number={number}
          index={index}
          count={numbers.length}
          error={errors[`ownerNumbers.${index}`]}
          onChange={(value) =>
            patch({
              ownerNumbers: numbers.map((item) =>
                item.id === number.id ? { ...item, value } : item,
              ),
            })
          }
          onMove={(offset) => move(index, offset)}
          onRemove={() =>
            patch({
              ownerNumbers: numbers.filter((item) => item.id !== number.id),
            })
          }
        />
      ))}
      {errors["ownerNumbers"] && (
        <div className="px-3 py-2">{fieldError(errors["ownerNumbers"])}</div>
      )}
    </Section>
  );
}

// Describes the saved line only while the draft still names the same bot.
function savedLineState(gateway: VoiceGateway, line: DraftLine) {
  const username = line.username.trim();
  const saved = gateway.config.lines.find((item) => item.username === username);

  if (saved?.botId !== line.botId) return null;

  const unavailable = gateway.unavailableLines.find(
    (item) => item.username === username,
  );

  if (unavailable) return UNAVAILABLE_LABELS[unavailable.reason];

  const report = gateway.lines.find((item) => item.username === username);

  if (!report) return null;

  return {
    badge: null,
    description: report.registered
      ? "Registered"
      : (report.error ?? "Not registered"),
  };
}

function LineRow({
  line,
  index,
  bots,
  gateway,
  error,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  index: number;
  bots: Bot[];
  gateway: VoiceGateway;
  error: string | undefined;
  onChange: (next: Partial<DraftLine>) => void;
  onRemove: () => void;
}) {
  const state = savedLineState(gateway, line);
  const botName = bots.find((bot) => bot.id === line.botId)?.name;
  const callsOwnerId = `voice-line-${line.id}-calls-owner`;
  const callsOthersId = `voice-line-${line.id}-calls-others`;

  return (
    <SettingRow
      tile={
        <RowTile>
          <IconDeviceLandlinePhone />
        </RowTile>
      }
      title={
        <>
          <Input
            aria-label={`SIP username for line ${index + 1}`}
            placeholder="SIP username"
            value={line.username}
            autoComplete="off"
            spellCheck={false}
            className="h-8 max-w-40 font-mono"
            aria-invalid={Boolean(error) || undefined}
            onChange={(event) => onChange({ username: event.target.value })}
          />
          <Input
            aria-label={`Display name for line ${index + 1}`}
            placeholder={botName ?? "Display name"}
            value={line.displayName}
            autoComplete="off"
            className="h-8 max-w-40"
            onChange={(event) => onChange({ displayName: event.target.value })}
          />
          {state?.badge && <Badge variant="outline">{state.badge}</Badge>}
        </>
      }
      description={
        <>
          {fieldError(error) ?? state?.description}
          <span id={`${callsOthersId}-help`} className="block">
            {CALLS_OTHERS_HELP}
          </span>
        </>
      }
    >
      <BotSelect
        label={`Bot for line ${index + 1}`}
        bots={bots}
        value={line.botId || null}
        invalid={Boolean(error)}
        onChange={(botId) => onChange({ botId: botId ?? "" })}
      />
      <label
        htmlFor={callsOwnerId}
        className="ml-2 text-xs whitespace-nowrap text-muted-foreground"
      >
        Can call you
      </label>
      <Switch
        id={callsOwnerId}
        checked={line.callsOwner}
        onCheckedChange={(callsOwner) => onChange({ callsOwner })}
      />
      <label
        htmlFor={callsOthersId}
        className="ml-2 text-xs whitespace-nowrap text-muted-foreground"
      >
        Can call other people
      </label>
      <Switch
        id={callsOthersId}
        aria-describedby={`${callsOthersId}-help`}
        checked={line.callsOthers}
        onCheckedChange={(callsOthers) => onChange({ callsOthers })}
      />
      <RemoveRowButton title="Remove line" onClick={onRemove} />
    </SettingRow>
  );
}

function LinesSection({ draft, bots, errors, gateway, patch }: FieldsProps) {
  const setLine = (id: string, next: Partial<DraftLine>) =>
    patch({
      lines: draft.lines.map((line) =>
        line.id === id ? { ...line, ...next } : line,
      ),
    });

  return (
    <Section
      title="Lines"
      description="Each line is an account on your telephone system that one bot answers. Its SIP password stays with the voice gateway. Callers hear the display name, or the bot's name when it's empty."
      action={
        <AddRowButton
          label="Line"
          disabled={!bots.length}
          onClick={() =>
            patch({
              lines: [
                ...draft.lines,
                {
                  id: randomId(),
                  username: "",
                  botId: "",
                  displayName: "",
                  callsOwner: false,
                  callsOthers: false,
                },
              ],
            })
          }
        />
      }
    >
      {draft.lines.length === 0 && <SectionEmpty>No lines yet.</SectionEmpty>}
      {draft.lines.map((line, index) => (
        <LineRow
          key={line.id}
          line={line}
          index={index}
          bots={bots}
          gateway={gateway}
          error={errors[`lines.${index}`]}
          onChange={(next) => setLine(line.id, next)}
          onRemove={() =>
            patch({ lines: draft.lines.filter((item) => item.id !== line.id) })
          }
        />
      ))}
      {errors["lines"] && (
        <div className="px-3 py-2">{fieldError(errors["lines"])}</div>
      )}
    </Section>
  );
}

function ConfirmAction({
  title,
  description,
  action,
  destructive = false,
  disabled,
  onConfirm,
}: {
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={disabled}>
            {action}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TokenSheet({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  return (
    <EditorSheet
      title="Voice gateway token"
      description="Copy it now. It's shown only once."
      submitLabel="Done"
      submitDisabled={false}
      onSubmit={onClose}
      onClose={onClose}
    >
      <Field>
        <div className="flex items-center gap-1">
          <Input
            readOnly
            aria-label="Voice gateway token"
            value={token}
            className="font-mono"
            onFocus={(event) => event.target.select()}
          />
          <CopyButton text={token} />
        </div>
        <FieldDescription>
          Give it to the voice gateway. Anyone with it can send spoken messages
          to the bots that have a line, as you.
        </FieldDescription>
      </Field>
    </EditorSheet>
  );
}

function TokenRow({ gateway }: { gateway: VoiceGateway }) {
  const issue = useMutation({
    mutationFn: () =>
      call<"issueVoiceGatewayToken">("/v1/voice-gateway/token", "POST"),
    onSuccess: refresh,
  });

  const revoke = useMutation({
    mutationFn: () =>
      send<"revokeVoiceGatewayToken">("/v1/voice-gateway/token", "DELETE"),
    onSuccess: refresh,
  });

  const pending = issue.isPending || revoke.isPending;
  const error = issue.error ?? revoke.error;

  return (
    <>
      <SettingRow
        tile={
          <RowTile>
            <IconKey />
          </RowTile>
        }
        title="Voice gateway token"
        description={
          error
            ? fieldError(error.message)
            : gateway.token
              ? `Issued ${new Date(gateway.token.issuedAt).toLocaleString()}`
              : "Not issued. The voice gateway connects with this token."
        }
      >
        {gateway.token ? (
          <>
            <ConfirmAction
              title="Issue a new voice gateway token?"
              description="The current token stops working at once, and the voice gateway disconnects until you give it the new one."
              action="Issue new token"
              disabled={pending}
              onConfirm={() => issue.mutate()}
            />
            <ConfirmAction
              title="Revoke the voice gateway token?"
              description="The voice gateway disconnects at once and can't connect again until you issue a new token."
              action="Revoke"
              destructive
              disabled={pending}
              onConfirm={() => revoke.mutate()}
            />
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => issue.mutate()}
          >
            Issue token
          </Button>
        )}
      </SettingRow>
      {issue.data && (
        <TokenSheet token={issue.data.token} onClose={() => issue.reset()} />
      )}
    </>
  );
}

function VoiceGatewayEditor({
  gateway,
  bots,
}: {
  gateway: VoiceGateway;
  bots: Bot[];
}) {
  const [draft, setDraft] = useState(() => draftOf(gateway.config));
  const [attempted, setAttempted] = useState(false);
  const config = configOf(draft);
  const parsed = voiceGatewayConfigInput.safeParse(config);
  const errors = voiceErrors(config, bots, parsed);

  const restart = (next: VoiceGatewayConfig) => {
    setDraft(draftOf(next));
    setAttempted(false);
  };

  const save = useMutation({
    mutationFn: (next: VoiceGatewayConfig) =>
      call<"updateVoiceGateway">("/v1/voice-gateway", "PUT", next),
    onSuccess: (next) => {
      restart(next.config);
      queryClient.setQueryData(voiceGatewayQuery.queryKey, next);
    },
  });

  const fields: FieldsProps = {
    draft,
    bots,
    gateway,
    errors: attempted ? errors : {},
    patch: (next) => setDraft((current) => ({ ...current, ...next })),
  };

  return (
    <>
      {/* Outside the form: the token sheet's submit would bubble into it through the portal. */}
      <ConnectionSection {...fields} />
      <form
        className="flex flex-col gap-8"
        aria-busy={save.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);

          if (parsed.success && !Object.keys(errors).length)
            save.mutate(parsed.data);
        }}
      >
        <NumbersSection {...fields} />
        <LinesSection {...fields} />
        {/* Compared in draft form: a stored line may omit callsOthers, which a save always sends. */}
        <SaveBar
          dirty={
            JSON.stringify(config) !==
            JSON.stringify(configOf(draftOf(gateway.config)))
          }
          save={save}
          onReset={() => {
            restart(gateway.config);
            save.reset();
          }}
        />
      </form>
    </>
  );
}

export function VoiceGatewaySettings() {
  const gateway = useQuery(voiceGatewayQuery);
  const bots = useQuery(botsQuery);

  return (
    <>
      <QueryState
        pending={gateway.isPending || bots.isPending}
        error={gateway.error ?? bots.error}
      />
      {gateway.data && bots.data && (
        <VoiceGatewayEditor gateway={gateway.data} bots={bots.data} />
      )}
    </>
  );
}

export function VoiceGatewayPage() {
  const gateway = useQuery(voiceGatewayQuery);

  return (
    <Page
      title="Voice gateway"
      onRefresh={() => void refresh()}
      refreshing={gateway.isFetching}
    >
      <VoiceGatewaySettings />
    </Page>
  );
}

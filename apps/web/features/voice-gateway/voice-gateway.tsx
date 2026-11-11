import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  IconArrowDown,
  IconArrowUp,
  IconKey,
  IconPhone,
  IconTrash,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import { voiceGatewayConfigInput } from "@crumble/server/contract/voice-gateway";
import { cn, randomId } from "@/lib/utils";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CopyButton, EditorSheet } from "@/components/form-fields";
import {
  Page,
  RowTile,
  Section,
  SectionEmpty,
  SettingRow,
} from "@/components/page";
import {
  AddRowButton,
  QueryState,
  RemoveRowButton,
  SaveBar,
} from "@/components/config-editor";
import { Heading } from "@/components/table-frame";
import { type Bot, botsQuery } from "@/features/bots/api";
import { BotSelect } from "@/features/bots/bot-select";
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

const GATEWAY_UNREACHABLE: Record<
  Exclude<VoiceGateway["status"], "connected">,
  { label: string; detail: string }
> = {
  disconnected: {
    label: "Offline",
    detail: "The voice gateway isn't connected.",
  },
  connecting: {
    label: "Connecting",
    detail: "The voice gateway is connecting.",
  },
  error: { label: "Offline", detail: "The voice gateway can't connect." },
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

  if (unavailable) {
    const { badge, description } = UNAVAILABLE_LABELS[unavailable.reason];

    return { label: badge ?? description, detail: description, badge: true };
  }

  if (!gateway.config.enabled)
    return { label: "Off", detail: "The voice gateway is turned off." };

  if (gateway.status !== "connected")
    return GATEWAY_UNREACHABLE[gateway.status];

  const report = gateway.lines.find((item) => item.username === username);

  if (!report)
    return {
      label: "Waiting",
      detail: "The voice gateway hasn't reported this line yet.",
    };

  if (report.registered) return { label: "Registered" };

  return { label: "Not registered", detail: report.error ?? undefined };
}

function LineStatus({ state }: { state: ReturnType<typeof savedLineState> }) {
  if (!state) return <span className="text-muted-foreground">Not saved</span>;

  if (state.badge)
    return (
      <Badge variant="outline" title={state.detail}>
        {state.label}
      </Badge>
    );

  return (
    <span className="text-muted-foreground" title={state.detail}>
      {state.label}
    </span>
  );
}

function LineRow({
  line,
  index,
  bots,
  gateway,
  error,
  selected,
  onSelect,
  onChange,
}: {
  line: DraftLine;
  index: number;
  bots: Bot[];
  gateway: VoiceGateway;
  error: string | undefined;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onChange: (next: Partial<DraftLine>) => void;
}) {
  const botName = bots.find((bot) => bot.id === line.botId)?.name;
  const invalid = Boolean(error) || undefined;
  const rowState = selected ? "selected" : undefined;

  return (
    <>
      <TableRow
        data-state={rowState}
        className={cn("hover:bg-transparent", error && "border-0")}
      >
        <TableCell className="w-0">
          <input
            type="checkbox"
            className="checkbox"
            aria-label={`Select line ${index + 1}`}
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
        </TableCell>
        <TableCell>
          <Input
            aria-label={`SIP username for line ${index + 1}`}
            value={line.username}
            autoComplete="off"
            spellCheck={false}
            className="min-w-32 font-mono"
            aria-invalid={invalid}
            onChange={(event) => onChange({ username: event.target.value })}
          />
        </TableCell>
        <TableCell>
          <Input
            aria-label={`Display name for line ${index + 1}`}
            placeholder={botName}
            value={line.displayName}
            autoComplete="off"
            className="min-w-32"
            onChange={(event) => onChange({ displayName: event.target.value })}
          />
        </TableCell>
        <TableCell>
          <BotSelect
            label={`Bot for line ${index + 1}`}
            bots={bots}
            value={line.botId || null}
            invalid={Boolean(error)}
            onChange={(botId) => onChange({ botId: botId ?? "" })}
          />
        </TableCell>
        <TableCell className="text-center">
          <input
            type="checkbox"
            className="checkbox"
            aria-label={`Line ${index + 1} can call you`}
            checked={line.callsOwner}
            onChange={(event) => onChange({ callsOwner: event.target.checked })}
          />
        </TableCell>
        <TableCell className="text-center">
          <input
            type="checkbox"
            className="checkbox"
            aria-label={`Line ${index + 1} can call other people`}
            aria-describedby="voice-lines-calls-others-help"
            checked={line.callsOthers}
            onChange={(event) =>
              onChange({ callsOthers: event.target.checked })
            }
          />
        </TableCell>
        <TableCell>
          <LineStatus state={savedLineState(gateway, line)} />
        </TableCell>
      </TableRow>
      {error && (
        <TableRow data-state={rowState} className="hover:bg-transparent">
          <TableCell />
          <TableCell colSpan={6} className="pt-0">
            {fieldError(error)}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function SelectAllLines({
  count,
  total,
  onChange,
}: {
  count: number;
  total: number;
  onChange: (selected: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      className="checkbox"
      aria-label="Select all lines"
      ref={(node) => {
        if (node) node.indeterminate = count > 0 && count < total;
      }}
      checked={count > 0 && count === total}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function LinesTable({
  draft,
  bots,
  errors,
  gateway,
  selected,
  setSelected,
  setLine,
}: Pick<FieldsProps, "draft" | "bots" | "errors" | "gateway"> & {
  selected: Set<string>;
  setSelected: (selected: Set<string>) => void;
  setLine: (id: string, next: Partial<DraftLine>) => void;
}) {
  const count = draft.lines.filter((line) => selected.has(line.id)).length;

  const select = (id: string, on: boolean) => {
    const next = new Set(selected);

    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  return (
    <div className="px-2 py-1">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <Heading className="w-0">
              <SelectAllLines
                count={count}
                total={draft.lines.length}
                onChange={(on) =>
                  setSelected(
                    new Set(on ? draft.lines.map((line) => line.id) : []),
                  )
                }
              />
            </Heading>
            <Heading>SIP username</Heading>
            <Heading>Display name</Heading>
            <Heading>Bot</Heading>
            <Heading className="text-center">Calls you</Heading>
            <Heading className="text-center">Calls others</Heading>
            <Heading>Status</Heading>
          </TableRow>
        </TableHeader>
        <TableBody>
          {draft.lines.map((line, index) => (
            <LineRow
              key={line.id}
              line={line}
              index={index}
              bots={bots}
              gateway={gateway}
              error={errors[`lines.${index}`]}
              selected={selected.has(line.id)}
              onSelect={(on) => select(line.id, on)}
              onChange={(next) => setLine(line.id, next)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LineSelectionActions({
  count,
  onDelete,
  onClear,
}: {
  count: number;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Clear selection"
        onClick={onClear}
      >
        <IconX />
      </Button>
      <span className="pr-1 text-sm tabular-nums">{count} selected</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onDelete}
      >
        <IconTrash data-icon="inline-start" />
        Delete
      </Button>
    </div>
  );
}

function LinesSection({ draft, bots, errors, gateway, patch }: FieldsProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const count = draft.lines.filter((line) => selected.has(line.id)).length;

  const setLine = (id: string, next: Partial<DraftLine>) =>
    patch({
      lines: draft.lines.map((line) =>
        line.id === id ? { ...line, ...next } : line,
      ),
    });

  const addLine = () =>
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
    });

  return (
    <Section
      title="Lines"
      footer={
        <>
          Calls others:{" "}
          <span id="voice-lines-calls-others-help">{CALLS_OTHERS_HELP}</span>
        </>
      }
      description="SIP accounts your bots answer."
      action={
        count > 0 ? (
          <LineSelectionActions
            count={count}
            onClear={() => setSelected(new Set())}
            onDelete={() => {
              patch({
                lines: draft.lines.filter((line) => !selected.has(line.id)),
              });
              setSelected(new Set());
            }}
          />
        ) : (
          <AddRowButton
            label="Line"
            disabled={!bots.length}
            onClick={addLine}
          />
        )
      }
    >
      {draft.lines.length === 0 ? (
        <SectionEmpty>No lines yet.</SectionEmpty>
      ) : (
        <LinesTable
          draft={draft}
          bots={bots}
          errors={errors}
          gateway={gateway}
          selected={selected}
          setSelected={setSelected}
          setLine={setLine}
        />
      )}
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

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  IconClock,
  IconMessage,
  IconTerminal2,
  IconWebhook,
} from "@tabler/icons-react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { BotAvatar } from "@/components/bot-avatar";
import { EditorSection, EditorSheet } from "@/components/form-fields";
import { type Bot, capabilitiesQuery } from "@/features/bots/api";
import { eventSourcesQuery } from "@/features/event-sources/api";
import { call, send, type RequestBody, type ResponseBody } from "@/lib/api";
import { validTimezone } from "@crumble/server/contract/cron";
import {
  DEFAULT_SCHEDULE_TIMEOUT_SECONDS,
  MAX_CRON_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_SCHEDULE_COMMAND_CHARS,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULE_TIMEOUT_SECONDS,
} from "@crumble/server/contract/limits";
import { type Schedule, schedulePath, invalidateSchedules } from "./api";
import {
  type Recurrence,
  type When,
  InlineSelect,
  KINDS,
  RecurrenceParts,
  WHEN,
  cronOf,
  recurrenceOf,
  switchedTo,
} from "./recurrence";
import { LOCAL_ZONE, fromWallClock, inOneHour, wallClock } from "./timing";

export type Editing = { schedule: Schedule | null; agentId: string };

type AutomationDraft = {
  agentId: string;
  name: string;
  enabled: boolean;
  prompt: string;
  kind: Schedule["kind"];
  command: string;
  timeoutSeconds: string;
  notify: boolean;
  repeat: boolean;
  cron: string;
  timezone: string;
  runAt: string;
  onEvent: boolean;
  eventSourceId: string;
};

type AutomationBody = RequestBody<"createSchedule">;

const DEFAULT_CRON = "0 9 * * *";

function blankDraft(agentId: string): AutomationDraft {
  return {
    agentId,
    name: "",
    enabled: true,
    prompt: "",
    kind: "prompt",
    command: "",
    timeoutSeconds: String(DEFAULT_SCHEDULE_TIMEOUT_SECONDS),
    notify: true,
    repeat: false,
    cron: DEFAULT_CRON,
    timezone: LOCAL_ZONE,
    runAt: inOneHour(LOCAL_ZONE),
    onEvent: false,
    eventSourceId: "",
  };
}

function draftOf(agentId: string, schedule: Schedule): AutomationDraft {
  return {
    agentId,
    name: schedule.name,
    enabled: schedule.enabled,
    prompt: schedule.prompt,
    kind: schedule.kind,
    command: schedule.command ?? "",
    timeoutSeconds: String(schedule.timeoutSeconds),
    notify: schedule.notify,
    repeat: schedule.cron !== null,
    cron: schedule.cron ?? DEFAULT_CRON,
    timezone: schedule.timezone,
    runAt: schedule.runAt
      ? wallClock(new Date(schedule.runAt), schedule.timezone)
      : inOneHour(schedule.timezone),
    onEvent: schedule.eventSourceId !== null,
    eventSourceId: schedule.eventSourceId ?? "",
  };
}

function initialDraft(editing: Editing) {
  return editing.schedule
    ? draftOf(editing.agentId, editing.schedule)
    : blankDraft(editing.agentId);
}

function kindFields(
  draft: AutomationDraft,
):
  | { error: string }
  | { fields: Pick<AutomationBody, "prompt" | "command" | "timeoutSeconds"> } {
  if (draft.kind === "prompt") {
    if (!draft.name.trim() || !draft.prompt.trim())
      return { error: "Automation name and prompt are required." };

    return {
      fields: {
        prompt: draft.prompt.trim(),
        command: null,
        timeoutSeconds: DEFAULT_SCHEDULE_TIMEOUT_SECONDS,
      },
    };
  }

  if (!draft.name.trim() || !draft.command.trim())
    return { error: "Automation name and command are required." };

  const timeoutSeconds = Number(draft.timeoutSeconds);

  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_SCHEDULE_TIMEOUT_SECONDS
  )
    return {
      error: `Timeout must be between 1 and ${MAX_SCHEDULE_TIMEOUT_SECONDS} seconds.`,
    };

  return { fields: { prompt: "", command: draft.command, timeoutSeconds } };
}

type Trigger = Pick<AutomationBody, "cron" | "runAt" | "eventSourceId">;

function triggerFields(
  draft: AutomationDraft,
  timezone: string,
): { error: string } | { trigger: Trigger } {
  if (draft.onEvent)
    return {
      trigger: { cron: null, runAt: null, eventSourceId: draft.eventSourceId },
    };

  if (draft.repeat)
    return {
      trigger: { cron: draft.cron.trim(), runAt: null, eventSourceId: null },
    };

  const instant = fromWallClock(draft.runAt, timezone);

  return instant
    ? {
        trigger: {
          cron: null,
          runAt: instant.toISOString(),
          eventSourceId: null,
        },
      }
    : { error: "Choose a valid date and time." };
}

function automationBody(
  draft: AutomationDraft,
): { error: string } | { body: AutomationBody } {
  const content = kindFields(draft);

  if ("error" in content) return content;

  const timezone = draft.timezone.trim();
  const when = triggerFields(draft, timezone);

  if ("error" in when) return when;

  return {
    body: {
      agentId: draft.agentId,
      name: draft.name.trim(),
      ...content.fields,
      kind: draft.kind,
      notify: draft.notify,
      timezone,
      enabled: draft.enabled,
      ...when.trigger,
    },
  };
}

function useSaveAutomation(schedule: Schedule | null, onClose: () => void) {
  return useMutation({
    mutationFn: (body: AutomationBody) =>
      schedule
        ? send<"updateSchedule">(schedulePath(schedule.id), "PATCH", body)
        : send<"createSchedule">("/v1/schedules", "POST", body),
    onSuccess: async () => {
      await invalidateSchedules();
      onClose();
    },
  });
}

export function AutomationDialog({
  bots,
  editing,
  onClose,
}: {
  bots: Bot[];
  editing: Editing;
  onClose: () => void;
}) {
  const initial = editing.schedule;
  const [draft, setDraft] = useState(() => initialDraft(editing));
  const [error, setError] = useState<string | null>(null);
  const save = useSaveAutomation(initial, onClose);
  const preview = useSchedulePreview(draft);

  const patch = (change: Partial<AutomationDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  const submit = () => {
    setError(null);

    if (
      preview.pending ||
      preview.error ||
      !preview.data ||
      preview.data.isProblem
    )
      return;

    const result = automationBody(draft);

    if ("error" in result) return setError(result.error);

    save.mutate(result.body);
  };

  const failure = error ?? save.error?.message;

  return (
    <EditorSheet
      title={initial ? "Edit Automation" : "New Automation"}
      description="The bot gets this at the time you choose and answers in its chat."
      error={failure}
      submitLabel={initial ? "Save" : "Create"}
      submitDisabled={
        save.isPending ||
        preview.pending ||
        preview.error ||
        !preview.data ||
        preview.data.isProblem
      }
      onSubmit={submit}
      onClose={onClose}
    >
      <AutomationFields
        bots={bots}
        draft={draft}
        patch={patch}
        editingScript={initial?.kind === "script"}
        preview={preview}
      />
    </EditorSheet>
  );
}

function ScriptFields({
  draft,
  patch,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="automation-command">Command</FieldLabel>
        <Textarea
          id="automation-command"
          className="min-h-28 font-mono"
          placeholder="./scripts/backup.sh"
          maxLength={MAX_SCHEDULE_COMMAND_CHARS}
          value={draft.command}
          onChange={(event) => patch({ command: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="automation-timeout">Timeout (seconds)</FieldLabel>
        <Input
          id="automation-timeout"
          type="number"
          required
          min={1}
          max={MAX_SCHEDULE_TIMEOUT_SECONDS}
          step={1}
          value={draft.timeoutSeconds}
          onChange={(event) => patch({ timeoutSeconds: event.target.value })}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="automation-notify">
            Send results to the chat
          </FieldLabel>
          <FieldDescription>
            Each finished run posts its output to the bot's chat.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="automation-notify"
          checked={draft.notify}
          onCheckedChange={(notify) => patch({ notify })}
        />
      </Field>
    </>
  );
}

export function useSchedulePreview(draft: AutomationDraft) {
  const zone = draft.timezone.trim();

  const instant =
    !draft.repeat && !draft.onEvent && validTimezone(zone)
      ? fromWallClock(draft.runAt, zone)
      : null;

  const input = {
    cron: draft.repeat && !draft.onEvent ? draft.cron.trim() : null,
    runAt: instant?.toISOString() ?? null,
    eventSourceId: draft.onEvent ? draft.eventSourceId : null,
    timezone: zone,
  };

  const key = JSON.stringify(input);
  const [debounced, setDebounced] = useState(key);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(key), 250);

    return () => clearTimeout(timer);
  }, [key]);

  const preview = useQuery({
    queryKey: ["schedule-preview", debounced],
    queryFn: () =>
      call<"previewSchedule">(
        "/v1/schedules/preview",
        "POST",
        JSON.parse(debounced),
      ),
    enabled: debounced === key,
  });

  const current = debounced === key;

  return {
    data: current ? preview.data : undefined,
    error: current && preview.isError,
    pending: !current || preview.isPending || preview.isFetching,
    retry: () => (current ? preview.refetch() : Promise.resolve()),
  };
}

function BotPicker({
  bots,
  draft,
  patch,
  canCode,
}: {
  bots: Bot[];
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
  canCode: (agentId: string) => boolean;
}) {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const items = bots.map((bot) => ({ label: bot.name, value: bot.id }));

  return (
    <Field>
      <FieldLabel>Runs on</FieldLabel>
      <Select
        items={items}
        value={draft.agentId}
        onValueChange={(value) => {
          if (!value) return;

          patch({
            agentId: value,
            kind: canCode(value) ? draft.kind : "prompt",
          });
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue>
            {(value: string) => {
              const bot = byId.get(value);

              return bot ? <BotChoice bot={bot} /> : null;
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {bots.map((bot) => (
              <SelectItem key={bot.id} value={bot.id}>
                <BotChoice bot={bot} />
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function BotChoice({ bot }: { bot: Bot }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <BotAvatar bot={bot} size={20} />
      <span className="truncate">{bot.name}</span>
    </span>
  );
}

const whenOf = (
  draft: AutomationDraft,
  custom: boolean,
  recurrence: Recurrence | null,
): When => {
  if (!draft.repeat) return "once";

  return custom || !recurrence ? "custom" : recurrence.kind;
};

function whenPatch(
  value: string,
  recurrence: Recurrence | null,
): Partial<AutomationDraft> {
  if (value === "once") return { repeat: false };

  const picked = KINDS.find((each) => each === value);

  return picked
    ? { repeat: true, cron: cronOf(switchedTo(picked, recurrence)) }
    : { repeat: true };
}

function WhenDetails({
  when,
  draft,
  recurrence,
  patch,
}: {
  when: When;
  draft: AutomationDraft;
  recurrence: Recurrence | null;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  if (when === "once")
    return (
      <Input
        type="datetime-local"
        aria-label="Date and time"
        className="w-auto"
        value={draft.runAt}
        onChange={(event) => patch({ runAt: event.target.value })}
      />
    );

  if (when === "custom" || !recurrence) return null;

  return (
    <RecurrenceParts
      recurrence={recurrence}
      onChange={(next) => patch({ repeat: true, cron: cronOf(next) })}
    />
  );
}

function EventSourcePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (eventSourceId: string) => void;
}) {
  const sources = useQuery(eventSourcesQuery);

  if (sources.data?.length === 0)
    return (
      <span className="text-sm text-muted-foreground">
        Add a source in{" "}
        <Link to="/settings/event-relay" className="underline">
          Settings › Event relay
        </Link>{" "}
        first.
      </span>
    );

  return (
    <InlineSelect
      label="Event source"
      value={value}
      items={[
        ...(value ? [] : [{ value: "", label: "Choose a source" }]),
        ...(sources.data ?? []).map((source) => ({
          value: source.id,
          label: source.name,
        })),
      ]}
      onChange={onChange}
    />
  );
}

function CronField({
  draft,
  patch,
  description,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
  description?: string | undefined;
}) {
  return (
    <Field>
      <Input
        aria-label="Cron"
        className="font-mono"
        placeholder="0 9 * * 1-5"
        maxLength={MAX_CRON_CHARS}
        value={draft.cron}
        onChange={(event) => patch({ cron: event.target.value })}
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

function TimeFields({
  draft,
  patch,
  preview,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
  preview: ResponseBody<"previewSchedule"> | undefined;
}) {
  const recurrence = recurrenceOf(draft.cron);
  const [custom, setCustom] = useState(draft.repeat && recurrence === null);
  const when = whenOf(draft, custom, recurrence);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <InlineSelect
          label="When"
          value={when}
          items={WHEN}
          onChange={(value) => {
            setCustom(value === "custom");
            patch(whenPatch(value, recurrence));
          }}
        />
        <WhenDetails
          when={when}
          draft={draft}
          recurrence={recurrence}
          patch={patch}
        />
      </div>
      {when === "custom" && (
        <CronField
          draft={draft}
          patch={patch}
          description={preview?.description}
        />
      )}
      {preview && (
        <p
          className={
            preview.isProblem
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {preview.text}
        </p>
      )}
    </>
  );
}

function EventFields({
  draft,
  patch,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  return (
    <Field>
      <FieldLabel>Event source</FieldLabel>
      <EventSourcePicker
        value={draft.eventSourceId}
        onChange={(eventSourceId) => patch({ eventSourceId })}
      />
    </Field>
  );
}

function ScheduleFields({
  draft,
  patch,
  preview,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
  preview: ResponseBody<"previewSchedule"> | undefined;
}) {
  return (
    <>
      <Tabs
        value={draft.onEvent ? "event" : "time"}
        onValueChange={(value) => patch({ onEvent: value === "event" })}
      >
        <TabsList aria-label="Trigger" className="w-full">
          <TabsTrigger value="time">
            <IconClock data-icon="inline-start" />
            Time
          </TabsTrigger>
          <TabsTrigger value="event">
            <IconWebhook data-icon="inline-start" />
            Event
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {draft.onEvent ? (
        <>
          <EventFields draft={draft} patch={patch} />
          {preview?.isProblem && (
            <p className="text-sm text-destructive">{preview.text}</p>
          )}
        </>
      ) : (
        <TimeFields draft={draft} patch={patch} preview={preview} />
      )}
    </>
  );
}

function AutomationKindTabs({
  kind,
  canScript,
  patch,
}: {
  kind: AutomationDraft["kind"];
  canScript: boolean;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  return (
    <Tabs
      value={kind}
      onValueChange={(value) =>
        patch({ kind: value === "script" ? "script" : "prompt" })
      }
    >
      <TabsList aria-label="Automation kind" className="w-full">
        <TabsTrigger value="prompt">
          <IconMessage data-icon="inline-start" />
          Prompt
        </TabsTrigger>
        <TabsTrigger value="script" disabled={!canScript}>
          <IconTerminal2 data-icon="inline-start" />
          Script
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function PromptField({
  draft,
  patch,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor="automation-prompt">Prompt</FieldLabel>
      <Textarea
        id="automation-prompt"
        className="min-h-28"
        placeholder="Summarize my unread email and flag anything urgent."
        maxLength={MAX_MESSAGE_CHARS}
        value={draft.prompt}
        onChange={(event) => patch({ prompt: event.target.value })}
      />
    </Field>
  );
}

function EnabledSection({
  draft,
  patch,
}: {
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
}) {
  return (
    <EditorSection>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="automation-enabled">Enabled</FieldLabel>
        </FieldContent>
        <Switch
          id="automation-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </Field>
    </EditorSection>
  );
}

export function PreviewStatus({
  preview,
}: {
  preview: ReturnType<typeof useSchedulePreview>;
}) {
  if (preview.error)
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        Could not load schedule preview.{" "}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void preview.retry()}
        >
          Retry
        </Button>
      </div>
    );

  if (preview.pending)
    return (
      <p className="text-sm text-muted-foreground">Loading schedule preview…</p>
    );

  return null;
}

function AutomationFields({
  bots,
  draft,
  patch,
  editingScript,
  preview,
}: {
  bots: Bot[];
  draft: AutomationDraft;
  patch: (change: Partial<AutomationDraft>) => void;
  editingScript: boolean;
  preview: ReturnType<typeof useSchedulePreview>;
}) {
  const capabilities = useQuery(capabilitiesQuery).data;

  const canCode = (agentId: string) =>
    capabilities?.coding === true &&
    bots.some((bot) => bot.id === agentId && bot.tools.includes("coding"));

  const canScript = canCode(draft.agentId);

  return (
    <>
      <EditorSection title="Automation">
        <Field>
          <FieldLabel htmlFor="automation-name">Name</FieldLabel>
          <Input
            id="automation-name"
            placeholder="Morning inbox triage"
            maxLength={MAX_SCHEDULE_NAME_CHARS}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>
        <BotPicker bots={bots} draft={draft} patch={patch} canCode={canCode} />
        {(canScript || editingScript) && (
          <AutomationKindTabs
            kind={draft.kind}
            canScript={canScript}
            patch={patch}
          />
        )}
        {draft.kind === "script" ? (
          <ScriptFields draft={draft} patch={patch} />
        ) : (
          <PromptField draft={draft} patch={patch} />
        )}
      </EditorSection>
      <EditorSection title="When">
        <ScheduleFields draft={draft} patch={patch} preview={preview.data} />
        <PreviewStatus preview={preview} />
      </EditorSection>
      <EnabledSection draft={draft} patch={patch} />
    </>
  );
}

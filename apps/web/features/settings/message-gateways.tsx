import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconMessages, IconPlus, IconTrash } from "@tabler/icons-react";
import { gatewayConfigInput } from "@crumble/server/contract/message-gateway";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SelectOptions } from "@/components/form-fields";
import {
  RowTile,
  Section,
  SectionEmpty,
  SettingRow,
  WorkspacePage,
} from "@/components/workspace";
import {
  type Bot,
  type GatewayConfig,
  type MessageGateway,
  botsQuery,
  call,
  messageGatewayPath,
  messageGatewaysQuery,
  queryClient,
} from "@/lib/api";
import { PluginSettingRows } from "./plugin-settings";

type Draft = Omit<
  GatewayConfig,
  "ownerId" | "allowedChannelIds" | "aliases"
> & {
  ownerId: string;
  allowedChannelIds: string;
  aliases: (GatewayConfig["aliases"][number] & { id: string })[];
};

const draftOf = (config: GatewayConfig): Draft => ({
  ...config,
  ownerId: config.ownerId ?? "",
  allowedChannelIds: config.allowedChannelIds.join("\n"),
  aliases: config.aliases.map((alias) => ({
    ...alias,
    id: crypto.randomUUID(),
  })),
});

const idsOf = (value: string) => [
  ...new Set(value.split(/[\s,]+/).filter(Boolean)),
];

const configOf = (draft: Draft): GatewayConfig => ({
  ...draft,
  ownerId: draft.ownerId.trim() || null,
  allowedChannelIds: idsOf(draft.allowedChannelIds),
  aliases: draft.aliases.map(({ handle, botId }) => ({
    handle: handle.trim(),
    botId,
  })),
});

const refresh = () =>
  queryClient.invalidateQueries({ queryKey: messageGatewaysQuery.queryKey });

function BotSelect({
  id,
  bots,
  value,
  invalid,
  optional = false,
  onChange,
}: {
  id: string;
  bots: Bot[];
  value: string | null;
  invalid?: boolean;
  optional?: boolean;
  onChange: (value: string | null) => void;
}) {
  const items = [
    { value: "", label: optional ? "No default bot" : "Choose a bot" },
    ...bots.map((bot) => ({
      value: bot.id,
      label: bot.enabled ? bot.name : `${bot.name} (disabled)`,
    })),
    ...(value && !bots.some((bot) => bot.id === value)
      ? [{ value, label: "Deleted bot" }]
      : []),
  ];

  return (
    <Select
      items={items}
      value={value ?? ""}
      onValueChange={(next) => onChange(next || null)}
    >
      <SelectTrigger
        id={id}
        aria-invalid={invalid || undefined}
        className="w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectOptions items={items} />
    </Select>
  );
}

type GatewayErrors = Record<string, string | undefined>;

type GatewayFieldsProps = {
  prefix: string;
  draft: Draft;
  bots: Bot[];
  errors: GatewayErrors;
  patch: (next: Partial<Draft>) => void;
};

function gatewayIssueMessage(issue: { path: PropertyKey[]; message: string }) {
  if (issue.path[0] === "ownerId")
    return "Enter one user ID, without spaces or commas.";

  if (issue.path[0] === "aliases") {
    if (issue.path[2] === "handle")
      return "Enter a handle using letters, numbers, underscores or hyphens, without @.";

    if (issue.path[2] === "botId") return "Choose a bot for every alias.";
  }

  return issue.message;
}

function gatewayErrors(
  config: GatewayConfig,
  bots: Bot[],
  parsed: ReturnType<typeof gatewayConfigInput.safeParse>,
) {
  const errors: Record<string, string> = {};

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);

      errors[key] ??= gatewayIssueMessage(issue);
    }
  }

  const botExists = (id: string | null) => bots.some((bot) => bot.id === id);

  if (config.enabled && config.defaultBotId && !botExists(config.defaultBotId))
    errors["defaultBotId"] =
      "Choose another default bot. The saved bot was deleted.";

  if (
    config.enabled &&
    config.aliases.some((alias) => alias.botId && !botExists(alias.botId))
  )
    errors["aliases"] =
      "Choose an existing bot for every alias, or remove the alias.";

  return errors;
}

function gatewayWarnings(
  config: GatewayConfig,
  bots: Bot[],
  gateway: MessageGateway,
) {
  const warnings = [];

  if (!gateway.tokenConfigured)
    warnings.push("Save a bot token in Credentials to connect.");

  if (!config.defaultBotId)
    warnings.push(
      "Without a default bot, messages need an @handle or a reply to a gateway answer.",
    );

  if (!config.ownerId)
    warnings.push(
      "No owner is configured. Enter your user ID to receive messages.",
    );

  if (!config.allowedChannelIds.length && !config.allowDirectMessages)
    warnings.push(
      "All destinations are blocked. Add channel IDs or allow direct messages.",
    );

  if (
    bots.some(
      (bot) =>
        !bot.enabled &&
        (bot.id === config.defaultBotId ||
          config.aliases.some((alias) => alias.botId === bot.id)),
    )
  )
    warnings.push(
      "A selected bot is disabled. Messages routed to it will return an error.",
    );

  return warnings;
}

function GatewayConnectionStatus({ gateway }: { gateway: MessageGateway }) {
  return (
    <>
      <SettingRow
        tile={
          <RowTile>
            <IconMessages />
          </RowTile>
        }
        title="Connection status"
        description={`${gateway.tokenConfigured ? "Token saved" : "Token missing"}${gateway.pendingCount ? ` · ${gateway.pendingCount} pending` : ""}${gateway.failedCount ? ` · ${gateway.failedCount} failed` : ""}`}
      >
        <Badge
          variant={gateway.status === "error" ? "destructive" : "secondary"}
        >
          {!gateway.config.enabled
            ? "Disabled"
            : {
                disconnected: "Disconnected",
                connecting: "Connecting",
                connected: "Connected",
                error: "Connection error",
              }[gateway.status]}
        </Badge>
      </SettingRow>
      {gateway.error && (
        <div className="p-3">
          <Alert variant="destructive">
            <AlertTitle>Gateway connection needs attention</AlertTitle>
            <AlertDescription>{gateway.error}</AlertDescription>
          </Alert>
        </div>
      )}
    </>
  );
}

function GatewayBotFields({
  prefix,
  draft,
  bots,
  errors,
  patch,
}: GatewayFieldsProps) {
  return (
    <>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${prefix}-enabled`}>Enabled</FieldLabel>
          <FieldDescription>
            Connect after saving these settings.
          </FieldDescription>
        </FieldContent>
        <Switch
          id={`${prefix}-enabled`}
          checked={draft.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </Field>
      <Field data-invalid={Boolean(errors["defaultBotId"]) || undefined}>
        <FieldLabel htmlFor={`${prefix}-bot`}>Default bot</FieldLabel>
        <BotSelect
          id={`${prefix}-bot`}
          bots={bots}
          value={draft.defaultBotId}
          optional
          invalid={Boolean(errors["defaultBotId"])}
          onChange={(defaultBotId) => patch({ defaultBotId })}
        />
        <FieldDescription>
          {bots.length
            ? "Receives new messages without an @handle or reply."
            : "Create a bot to receive messages through this gateway."}
        </FieldDescription>
        <FieldError>{errors["defaultBotId"]}</FieldError>
      </Field>
    </>
  );
}

function GatewayAccessFields({
  prefix,
  draft,
  errors,
  patch,
  label,
}: Omit<GatewayFieldsProps, "bots"> & { label: string }) {
  return (
    <>
      <FieldGroup className="grid gap-5 sm:grid-cols-2">
        <Field data-invalid={Boolean(errors["ownerId"]) || undefined}>
          <FieldLabel htmlFor={`${prefix}-owner`}>
            Owner {label} user ID
          </FieldLabel>
          <Input
            id={`${prefix}-owner`}
            value={draft.ownerId}
            onChange={(event) => patch({ ownerId: event.target.value })}
            maxLength={200}
            autoComplete="off"
            aria-invalid={Boolean(errors["ownerId"]) || undefined}
            aria-describedby={`${prefix}-owner-help`}
          />
          <FieldDescription id={`${prefix}-owner-help`}>
            Enter your own user ID. Only this user can message your bots, with
            the same owner authority as the bot chat.
          </FieldDescription>
          <FieldError>{errors["ownerId"]}</FieldError>
        </Field>
        <Field data-invalid={Boolean(errors["allowedChannelIds"]) || undefined}>
          <FieldLabel htmlFor={`${prefix}-channels`}>
            Allowed channel IDs
          </FieldLabel>
          <Textarea
            id={`${prefix}-channels`}
            value={draft.allowedChannelIds}
            onChange={(event) =>
              patch({ allowedChannelIds: event.target.value })
            }
            rows={3}
            aria-invalid={Boolean(errors["allowedChannelIds"]) || undefined}
            aria-describedby={`${prefix}-channels-help`}
          />
          <FieldDescription id={`${prefix}-channels-help`}>
            Only these channels can reach bots. An empty list blocks all server
            channels.
          </FieldDescription>
          <FieldError>{errors["allowedChannelIds"]}</FieldError>
        </Field>
      </FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${prefix}-dm`}>
            Allow direct messages
          </FieldLabel>
          <FieldDescription>
            The owner can also message the gateway directly.
          </FieldDescription>
        </FieldContent>
        <Switch
          id={`${prefix}-dm`}
          checked={draft.allowDirectMessages}
          onCheckedChange={(allowDirectMessages) =>
            patch({ allowDirectMessages })
          }
        />
      </Field>
    </>
  );
}

function GatewayAliasFields({
  prefix,
  draft,
  bots,
  errors,
  patch,
}: GatewayFieldsProps) {
  return (
    <FieldSet data-invalid={Boolean(errors["aliases"]) || undefined}>
      <FieldLegend variant="label">Aliases</FieldLegend>
      <FieldDescription>
        Stable handles route messages such as @research summarize this. Use
        letters, numbers, underscores or hyphens, without @.
      </FieldDescription>
      <FieldGroup className="gap-3">
        {draft.aliases.map((alias, index) => (
          <div key={alias.id} className="flex items-end gap-2">
            <FieldGroup className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${prefix}-${alias.id}-handle`}>
                  Handle {index + 1}
                </FieldLabel>
                <Input
                  id={`${prefix}-${alias.id}-handle`}
                  value={alias.handle}
                  maxLength={100}
                  autoComplete="off"
                  aria-invalid={Boolean(errors["aliases"]) || undefined}
                  onChange={(event) =>
                    patch({
                      aliases: draft.aliases.map((item) =>
                        item.id === alias.id
                          ? { ...item, handle: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${prefix}-${alias.id}-bot`}>
                  Bot {index + 1}
                </FieldLabel>
                <BotSelect
                  id={`${prefix}-${alias.id}-bot`}
                  bots={bots}
                  value={alias.botId}
                  invalid={Boolean(errors["aliases"])}
                  onChange={(botId) =>
                    patch({
                      aliases: draft.aliases.map((item) =>
                        item.id === alias.id
                          ? { ...item, botId: botId ?? "" }
                          : item,
                      ),
                    })
                  }
                />
              </Field>
            </FieldGroup>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove alias ${alias.handle || index + 1}`}
              onClick={() =>
                patch({
                  aliases: draft.aliases.filter((item) => item.id !== alias.id),
                })
              }
            >
              <IconTrash />
            </Button>
          </div>
        ))}
      </FieldGroup>
      <FieldError>{errors["aliases"]}</FieldError>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={!bots.length}
        onClick={() =>
          patch({
            aliases: [
              ...draft.aliases,
              { id: crypto.randomUUID(), handle: "", botId: "" },
            ],
          })
        }
      >
        <IconPlus data-icon="inline-start" />
        Add alias
      </Button>
    </FieldSet>
  );
}

function GatewayEditor({
  gateway,
  bots,
}: {
  gateway: MessageGateway;
  bots: Bot[];
}) {
  const [draft, setDraft] = useState(() => draftOf(gateway.config));
  const [attempted, setAttempted] = useState(false);
  const config = configOf(draft);
  const parsed = gatewayConfigInput.safeParse(config);
  const errors = gatewayErrors(config, bots, parsed);
  const warnings = gatewayWarnings(config, bots, gateway);

  const save = useMutation({
    mutationFn: (next: GatewayConfig) =>
      call<MessageGateway, GatewayConfig>(
        messageGatewayPath(gateway.id),
        "PUT",
        next,
      ),
    onSuccess: async (next) => {
      setDraft(draftOf(next.config));
      setAttempted(false);
      queryClient.setQueryData(messageGatewaysQuery.queryKey, (current) =>
        current?.map((item) => (item.id === next.id ? next : item)),
      );

      await refresh();
    },
  });

  const dirty = JSON.stringify(config) !== JSON.stringify(gateway.config);
  const prefix = `gateway-${gateway.id}`;

  const patch = (next: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...next }));

  const fields = {
    prefix,
    draft,
    bots,
    errors: attempted ? errors : {},
    patch,
  };

  return (
    <Section
      title={gateway.label}
      description={`Message your existing bots from ${gateway.label}.`}
      footer="A leading @handle selects a bot for one message. Replies select the answering bot unless a prefix overrides it. Other chat activity is never forwarded."
    >
      <GatewayConnectionStatus gateway={gateway} />
      <form
        className="p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);

          if (!Object.keys(errors).length && parsed.success)
            save.mutate(parsed.data);
        }}
      >
        <FieldSet disabled={save.isPending} aria-busy={save.isPending}>
          <FieldGroup>
            {warnings.length ? (
              <Alert>
                <AlertTitle>Setup</AlertTitle>
                <AlertDescription>
                  <ul className="flex list-disc flex-col gap-1 pl-4">
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            <GatewayBotFields {...fields} />
            <GatewayAccessFields {...fields} label={gateway.label} />
            <GatewayAliasFields {...fields} />
            <FieldError>{save.error?.message}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <span
                className="mr-auto text-xs text-muted-foreground"
                role="status"
              >
                {save.isPending
                  ? "Saving…"
                  : dirty
                    ? "Unsaved changes"
                    : save.isSuccess
                      ? "Saved"
                      : ""}
              </span>
              <Button
                type="button"
                variant="ghost"
                disabled={!dirty}
                onClick={() => {
                  setDraft(draftOf(gateway.config));
                  setAttempted(false);
                  save.reset();
                }}
              >
                Reset
              </Button>
              <Button type="submit" disabled={!dirty || save.isPending}>
                Save changes
              </Button>
            </div>
          </FieldGroup>
        </FieldSet>
      </form>
    </Section>
  );
}

export function MessageGatewaysPage() {
  const gateways = useQuery(messageGatewaysQuery);
  const bots = useQuery(botsQuery);

  return (
    <WorkspacePage
      title="Message gateways"
      onRefresh={() => void refresh()}
      refreshing={gateways.isFetching}
    >
      <Section
        title="Credentials"
        description="Save the bot token to connect its gateway."
      >
        <PluginSettingRows contributes="chatAdapters" onChange={refresh} />
      </Section>
      {gateways.isPending || bots.isPending ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : null}
      {gateways.error || bots.error ? (
        <FieldError>{(gateways.error ?? bots.error)?.message}</FieldError>
      ) : null}
      {gateways.data && bots.data ? (
        gateways.data.length ? (
          gateways.data.map((gateway) => (
            <GatewayEditor
              key={gateway.id}
              gateway={gateway}
              bots={bots.data}
            />
          ))
        ) : (
          <Section title="Gateways">
            <SectionEmpty>
              No message gateway adapters are available on this server.
            </SectionEmpty>
          </Section>
        )
      ) : null}
    </WorkspacePage>
  );
}

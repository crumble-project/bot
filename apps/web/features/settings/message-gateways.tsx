import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  IconArrowLeft,
  IconAt,
  IconChevronRight,
  IconHash,
  IconMessage,
  IconPlus,
  IconRobot,
  IconTrash,
  IconUser,
} from "@tabler/icons-react";
import { gatewayConfigInput } from "@crumble/server/contract/message-gateway";
import { GatewayIcon } from "@/components/gateway-brand";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
  allowedChannelIds: { id: string; value: string }[];
  aliases: (GatewayConfig["aliases"][number] & { id: string })[];
};

const draftOf = (config: GatewayConfig): Draft => ({
  ...config,
  ownerId: config.ownerId ?? "",
  allowedChannelIds: config.allowedChannelIds.map((value) => ({
    id: crypto.randomUUID(),
    value,
  })),
  aliases: config.aliases.map((alias) => ({
    ...alias,
    id: crypto.randomUUID(),
  })),
});

const configOf = (draft: Draft): GatewayConfig => ({
  ...draft,
  ownerId: draft.ownerId.trim() || null,
  allowedChannelIds: [
    ...new Set(
      draft.allowedChannelIds
        .map((channel) => channel.value.trim())
        .filter(Boolean),
    ),
  ],
  aliases: draft.aliases.map(({ handle, botId }) => ({
    handle: handle.trim(),
    botId,
  })),
});

const refresh = () =>
  queryClient.invalidateQueries({ queryKey: messageGatewaysQuery.queryKey });

function GatewayLogo({ gateway }: { gateway: MessageGateway }) {
  return (
    <RowTile>
      <GatewayIcon id={gateway.id} />
    </RowTile>
  );
}

function GatewayStatus({ gateway }: { gateway: MessageGateway }) {
  if (!gateway.config.enabled) return <Badge variant="outline">Disabled</Badge>;

  return (
    <Badge variant={gateway.status === "error" ? "destructive" : "secondary"}>
      {
        {
          disconnected: "Disconnected",
          connecting: "Connecting",
          connected: "Connected",
          error: "Connection error",
        }[gateway.status]
      }
    </Badge>
  );
}

function BotSelect({
  id,
  label,
  bots,
  value,
  invalid,
  optional = false,
  onChange,
}: {
  id?: string;
  label: string;
  bots: Bot[];
  value: string | null;
  invalid?: boolean;
  optional?: boolean;
  onChange: (value: string | null) => void;
}) {
  const items = [
    { value: "", label: optional ? "None" : "Choose a bot" },
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
        aria-label={label}
        aria-invalid={invalid || undefined}
        className="w-48"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectOptions items={items} />
    </Select>
  );
}

type GatewayErrors = Record<string, string | undefined>;

function gatewayIssueMessage(issue: { path: PropertyKey[]; message: string }) {
  if (issue.path[0] === "ownerId")
    return "Enter one user ID, without spaces or commas.";

  if (issue.path[0] === "aliases") {
    if (issue.path[2] === "handle")
      return "Use letters, numbers, underscores or hyphens, without @.";

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
    errors["defaultBotId"] = "The saved bot was deleted. Choose another.";

  if (
    config.enabled &&
    config.aliases.some((alias) => alias.botId && !botExists(alias.botId))
  )
    errors["aliases"] = "Choose an existing bot for every alias.";

  return errors;
}

type FieldsProps = {
  prefix: string;
  draft: Draft;
  bots: Bot[];
  errors: GatewayErrors;
  patch: (next: Partial<Draft>) => void;
};

const fieldError = (message: string | undefined) =>
  message && <FieldError>{message}</FieldError>;

function ConnectionSection({
  gateway,
  prefix,
  draft,
  patch,
}: Omit<FieldsProps, "bots" | "errors"> & { gateway: MessageGateway }) {
  const deliveries = [
    gateway.pendingCount ? `${gateway.pendingCount} pending` : "",
    gateway.failedCount ? `${gateway.failedCount} failed` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Section title="Connection">
      <SettingRow
        tile={<GatewayLogo gateway={gateway} />}
        title={
          <>
            <label htmlFor={`${prefix}-enabled`}>{gateway.label}</label>
            <GatewayStatus gateway={gateway} />
            {deliveries && (
              <span className="font-normal text-muted-foreground">
                ({deliveries})
              </span>
            )}
          </>
        }
      >
        <Switch
          id={`${prefix}-enabled`}
          checked={draft.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </SettingRow>
      {gateway.error && (
        <div className="p-3">
          <Alert variant="destructive">
            <AlertTitle>Connection needs attention</AlertTitle>
            <AlertDescription>{gateway.error}</AlertDescription>
          </Alert>
        </div>
      )}
      <PluginSettingRows
        contributes="chatAdapters"
        secretKey={gateway.secretKey}
        onChange={refresh}
      />
    </Section>
  );
}

function BotsSection({ prefix, draft, bots, errors, patch }: FieldsProps) {
  const setAlias = (id: string, next: Partial<Draft["aliases"][number]>) =>
    patch({
      aliases: draft.aliases.map((alias) =>
        alias.id === id ? { ...alias, ...next } : alias,
      ),
    });

  return (
    <Section
      title="Bots"
      description="Start a message with @alias to pick a bot."
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
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
          Alias
        </Button>
      }
    >
      <SettingRow
        tile={
          <RowTile>
            <IconRobot />
          </RowTile>
        }
        title={<label htmlFor={`${prefix}-bot`}>Default bot</label>}
        description={fieldError(errors["defaultBotId"])}
      >
        <BotSelect
          id={`${prefix}-bot`}
          label="Default bot"
          bots={bots}
          value={draft.defaultBotId}
          optional
          invalid={Boolean(errors["defaultBotId"])}
          onChange={(defaultBotId) => patch({ defaultBotId })}
        />
      </SettingRow>
      {draft.aliases.map((alias, index) => (
        <SettingRow
          key={alias.id}
          tile={
            <RowTile>
              <IconAt />
            </RowTile>
          }
          title={
            <Input
              aria-label={`Alias ${index + 1}`}
              placeholder="research"
              value={alias.handle}
              maxLength={100}
              autoComplete="off"
              className="h-8 max-w-48"
              aria-invalid={Boolean(errors["aliases"]) || undefined}
              onChange={(event) =>
                setAlias(alias.id, { handle: event.target.value })
              }
            />
          }
        >
          <BotSelect
            label={`Bot for alias ${index + 1}`}
            bots={bots}
            value={alias.botId || null}
            invalid={Boolean(errors["aliases"])}
            onChange={(botId) => setAlias(alias.id, { botId: botId ?? "" })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Remove alias"
            onClick={() =>
              patch({
                aliases: draft.aliases.filter((item) => item.id !== alias.id),
              })
            }
          >
            <IconTrash />
          </Button>
        </SettingRow>
      ))}
      {errors["aliases"] && (
        <div className="px-3 py-2">{fieldError(errors["aliases"])}</div>
      )}
    </Section>
  );
}

function AccessSection({
  prefix,
  draft,
  errors,
  patch,
  label,
}: Omit<FieldsProps, "bots"> & { label: string }) {
  return (
    <Section
      title="Access"
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            patch({
              allowedChannelIds: [
                ...draft.allowedChannelIds,
                { id: crypto.randomUUID(), value: "" },
              ],
            })
          }
        >
          <IconPlus data-icon="inline-start" />
          Channel
        </Button>
      }
    >
      <SettingRow
        tile={
          <RowTile>
            <IconUser />
          </RowTile>
        }
        title={<label htmlFor={`${prefix}-owner`}>Owner {label} user ID</label>}
        description={fieldError(errors["ownerId"])}
      >
        <Input
          id={`${prefix}-owner`}
          value={draft.ownerId}
          onChange={(event) => patch({ ownerId: event.target.value })}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          className="h-8 w-48 font-mono"
          aria-invalid={Boolean(errors["ownerId"]) || undefined}
        />
      </SettingRow>
      <SettingRow
        tile={
          <RowTile>
            <IconMessage />
          </RowTile>
        }
        title={<label htmlFor={`${prefix}-dm`}>Direct messages</label>}
      >
        <Switch
          id={`${prefix}-dm`}
          checked={draft.allowDirectMessages}
          onCheckedChange={(allowDirectMessages) =>
            patch({ allowDirectMessages })
          }
        />
      </SettingRow>
      {draft.allowedChannelIds.map((channel, index) => (
        <SettingRow
          key={channel.id}
          tile={
            <RowTile>
              <IconHash />
            </RowTile>
          }
          title={
            <Input
              aria-label={`Channel ID ${index + 1}`}
              placeholder="Channel ID"
              value={channel.value}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              className="h-8 max-w-48 font-mono"
              onChange={(event) =>
                patch({
                  allowedChannelIds: draft.allowedChannelIds.map((item) =>
                    item.id === channel.id
                      ? { ...item, value: event.target.value }
                      : item,
                  ),
                })
              }
            />
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Remove channel"
            onClick={() =>
              patch({
                allowedChannelIds: draft.allowedChannelIds.filter(
                  (item) => item.id !== channel.id,
                ),
              })
            }
          >
            <IconTrash />
          </Button>
        </SettingRow>
      ))}
      {errors["allowedChannelIds"] && (
        <div className="px-3 py-2">
          {fieldError(errors["allowedChannelIds"])}
        </div>
      )}
    </Section>
  );
}

type SaveState = {
  isPending: boolean;
  isSuccess: boolean;
  error: Error | null;
};

function saveStatus(dirty: boolean, save: SaveState) {
  if (save.isPending) return "Saving…";

  if (dirty) return "Unsaved changes";

  return save.isSuccess ? "Saved" : "";
}

function SaveBar({
  dirty,
  save,
  onReset,
}: {
  dirty: boolean;
  save: SaveState;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="mr-auto text-sm text-muted-foreground" role="status">
        {save.error ? (
          <FieldError>{save.error.message}</FieldError>
        ) : (
          saveStatus(dirty, save)
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        disabled={!dirty || save.isPending}
        onClick={onReset}
      >
        Reset
      </Button>
      <Button type="submit" disabled={!dirty || save.isPending}>
        Save
      </Button>
    </div>
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

  const fields = {
    prefix: `gateway-${gateway.id}`,
    draft,
    bots,
    errors: attempted ? errors : {},
    patch: (next: Partial<Draft>) =>
      setDraft((current) => ({ ...current, ...next })),
  };

  return (
    <>
      {/* Outside the form: the token sheet's submit would bubble into it through the portal. */}
      <ConnectionSection gateway={gateway} {...fields} />
      <form
        className="flex flex-col gap-8"
        aria-busy={save.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);

          if (!Object.keys(errors).length && parsed.success)
            save.mutate(parsed.data);
        }}
      >
        <BotsSection {...fields} />
        <AccessSection {...fields} label={gateway.label} />
        <SaveBar
          dirty={dirty}
          save={save}
          onReset={() => {
            setDraft(draftOf(gateway.config));
            setAttempted(false);
            save.reset();
          }}
        />
      </form>
    </>
  );
}

function GatewayRow({ gateway }: { gateway: MessageGateway }) {
  return (
    <Link
      to="/settings/message-gateways/$gatewayId"
      params={{ gatewayId: gateway.id }}
      className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
    >
      <GatewayLogo gateway={gateway} />
      <span className="flex min-w-0 flex-1 items-center gap-2 font-medium">
        <span className="truncate">{gateway.label}</span>
        <GatewayStatus gateway={gateway} />
      </span>
      <IconChevronRight className="size-4 text-muted-foreground" />
    </Link>
  );
}

function QueryState({
  pending,
  error,
}: {
  pending: boolean;
  error: Error | null;
}) {
  if (error) return <FieldError>{error.message}</FieldError>;

  return pending ? <Skeleton className="h-64 w-full rounded-xl" /> : null;
}

/** Every message gateway the server offers, each opening its own page. */
export function MessageGatewaysPage() {
  const gateways = useQuery(messageGatewaysQuery);

  return (
    <WorkspacePage
      title="Message gateways"
      onRefresh={() => void refresh()}
      refreshing={gateways.isFetching}
    >
      <QueryState pending={gateways.isPending} error={gateways.error} />
      {gateways.data && (
        <Section
          title="Gateways"
          description="Message your bots from other chat apps."
        >
          {gateways.data.length ? (
            gateways.data.map((gateway) => (
              <GatewayRow key={gateway.id} gateway={gateway} />
            ))
          ) : (
            <SectionEmpty>This server has no message gateways.</SectionEmpty>
          )}
        </Section>
      )}
    </WorkspacePage>
  );
}

/** One gateway's connection, token, bots, and access, without the page header. */
export function MessageGatewaySettings({ gatewayId }: { gatewayId: string }) {
  const gateways = useQuery(messageGatewaysQuery);
  const bots = useQuery(botsQuery);
  const gateway = gateways.data?.find((item) => item.id === gatewayId);

  if (gateways.data && !gateway)
    return (
      <Section title="Not found">
        <SectionEmpty>This server has no gateway {gatewayId}.</SectionEmpty>
      </Section>
    );

  return (
    <>
      <QueryState
        pending={gateways.isPending || bots.isPending}
        error={gateways.error ?? bots.error}
      />
      {gateway && bots.data && (
        <GatewayEditor key={gateway.id} gateway={gateway} bots={bots.data} />
      )}
    </>
  );
}

export function MessageGatewayPage({ gatewayId }: { gatewayId: string }) {
  const gateways = useQuery(messageGatewaysQuery);
  const label = gateways.data?.find((item) => item.id === gatewayId)?.label;

  return (
    <WorkspacePage
      title={label ?? "Message gateway"}
      back={
        <Button
          variant="ghost"
          size="icon-sm"
          title="Back to message gateways"
          render={<Link to="/settings/message-gateways" />}
          nativeButton={false}
        >
          <IconArrowLeft />
        </Button>
      }
      onRefresh={() => void refresh()}
      refreshing={gateways.isFetching}
    >
      <MessageGatewaySettings gatewayId={gatewayId} />
    </WorkspacePage>
  );
}

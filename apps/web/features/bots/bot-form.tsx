import { Fragment, type ReactNode, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  PencilEdit01Icon,
  ShuffleIcon,
} from "@hugeicons/core-free-icons";
import { AlertDialog, AlertDialogTrigger } from "@/components/ui/alert-dialog";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn, randomId } from "@/lib/utils";
import {
  type Bot,
  type BotInput,
  type Capabilities,
  type McpServer,
  type Provider,
  agentPath,
  botsQuery,
  call,
  capabilitiesQuery,
  mcpServersQuery,
  modelsQuery,
  providersQuery,
  queryClient,
  send,
} from "@/lib/api";
import { BotAvatar } from "./avatar";
import { ConfirmDeleteContent, WorkspacePage } from "@/components/workspace";
import {
  type AvatarChoice,
  PALETTE,
  SILHOUETTES,
  formatAvatar,
  lookOf,
  parseAvatar,
} from "./bot-avatar";
import {
  type ThinkingLevel,
  ReasoningSelect,
  clampLevel,
  levelsOf,
} from "./reasoning";

const CAPABILITIES = [
  { tool: "memory", label: "Memory", help: "Remembers facts across chats." },
  {
    tool: "delegate",
    label: "Message other bots",
    help: "Asks the other bots for help.",
  },
  {
    tool: "coding",
    label: "Coding",
    help: "Runs coding jobs in its own workspace.",
  },
  {
    tool: "desktop",
    label: "Bot desktop",
    help: "Runs desktop jobs on its own computer.",
  },
] as const;

const DEFAULT_TOOLS = ["memory", "delegate"];

const DEFAULT_INSTRUCTIONS =
  "You are a thoughtful, capable personal assistant.";

const seedAvatar = () => `bot:${randomId()}`;

function providerItems(providers: Provider[], current: string) {
  const sorted = [...providers].sort(
    (a, b) => Number(b.configured) - Number(a.configured),
  );

  const items = sorted.map((each) => ({
    label: each.configured ? each.name : `${each.name} (not set up)`,
    value: each.provider,
  }));

  return current && !items.some((item) => item.value === current)
    ? [{ label: current, value: current }, ...items]
    : items;
}

function ProviderSelect({
  id,
  providers,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  providers: Provider[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const items = providerItems(providers, value);

  return (
    <Select
      items={[{ label: placeholder, value: null }, ...items]}
      value={value || null}
      onValueChange={(next) => onChange(next ?? "")}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** A model ID field with the provider's catalog as suggestions; any ID may be typed. */
function ModelField({
  id,
  provider,
  configured,
  value,
  onChange,
}: {
  id: string;
  provider: string;
  configured: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const models = useQuery({
    ...modelsQuery(provider),
    enabled: provider !== "",
  });

  const hint = !configured
    ? "Add an API key or sign in for this provider in Settings to load its models."
    : models.data?.length
      ? `${models.data.length} models available.`
      : "Type a model ID.";

  return (
    <>
      <Input
        id={id}
        list={`${id}-options`}
        placeholder={models.isFetching ? "Loading…" : "Model ID"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={`${id}-options`}>
        {models.data?.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </datalist>
      <FieldDescription>{hint}</FieldDescription>
    </>
  );
}

/** One switch in an editor section; `nested` rows belong to the row above them. */
function ToggleRow({
  id,
  label,
  description,
  icon,
  checked,
  disabled,
  nested,
  onChange,
}: {
  id: string;
  label: ReactNode;
  description?: string;
  icon?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  nested?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-3 px-3 py-2.5",
        nested && "bg-muted/30 pl-8",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-sm">{label}</span>
        {description && (
          <span className="truncate text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </label>
  );
}

function DisclosureRow({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between gap-4 p-3 text-sm transition-colors hover:bg-muted/50",
          open && "border-b bg-muted/30",
        )}
        onClick={() => setOpen(!open)}
      >
        <span className="font-medium">{title}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {summary}
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-4"
          />
        </span>
      </button>
      {open && <div className="flex flex-col divide-y">{children}</div>}
    </div>
  );
}

function useBotIdentity(bot?: Bot) {
  const [avatar, setAvatar] = useState(bot?.avatar ?? seedAvatar());
  const [name, setName] = useState(bot?.name ?? "");
  const [description, setDescription] = useState(bot?.description ?? "");

  return { avatar, setAvatar, name, setName, description, setDescription };
}

function useBotBehavior(bot?: Bot) {
  const [enabled, setEnabled] = useState(bot?.enabled ?? true);

  const [instructions, setInstructions] = useState(
    bot?.instructions ?? DEFAULT_INSTRUCTIONS,
  );

  return { enabled, setEnabled, instructions, setInstructions };
}

function useBotDetails(bot?: Bot) {
  return { ...useBotIdentity(bot), ...useBotBehavior(bot) };
}

function useBotModel(bot: Bot | undefined, providers: Provider[]) {
  const [provider, setProvider] = useState(
    bot?.provider ?? providers.find((each) => each.configured)?.provider ?? "",
  );

  const [model, setModel] = useState(bot?.model ?? "");

  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    bot?.inference?.thinkingLevel ?? "off",
  );

  const models = useQuery({
    ...modelsQuery(provider),
    enabled: provider !== "",
  }).data;

  const levels = levelsOf(models?.find((each) => each.id === model.trim()));
  const level = clampLevel(thinkingLevel, levels);

  return {
    provider,
    setProvider,
    model,
    setModel,
    levels,
    level,
    setThinkingLevel,
  };
}

function useBotAccess(bot?: Bot) {
  const [tools, setTools] = useState<string[]>(bot?.tools ?? DEFAULT_TOOLS);
  const [mcpServers, setMcpServers] = useState<string[]>(bot?.mcpServers ?? []);

  const [desktopProvider, setDesktopProvider] = useState(
    bot?.desktopModel?.provider ?? "",
  );

  const [desktopModel, setDesktopModel] = useState(
    bot?.desktopModel?.model ?? "",
  );

  return {
    tools,
    setTools,
    mcpServers,
    setMcpServers,
    desktopProvider,
    setDesktopProvider,
    desktopModel,
    setDesktopModel,
  };
}

function toggle(list: string[], item: string, on: boolean) {
  return on
    ? [...new Set([...list, item])]
    : list.filter((each) => each !== item);
}

function isConfigured(providers: Provider[], id: string) {
  return providers.find((each) => each.provider === id)?.configured ?? false;
}

function useBotMutations(bot: Bot | undefined, input: () => BotInput) {
  const navigate = useNavigate();

  const after = async (saved: Bot) => {
    await queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
    await navigate({ to: "/bots/$botId", params: { botId: saved.id } });
  };

  const save = useMutation({
    mutationFn: () => {
      const values = input();

      return bot
        ? call<
            Bot,
            BotInput & { desktopModel: BotInput["desktopModel"] | null }
          >(agentPath(bot.id), "PATCH", {
            ...values,
            desktopModel: values.desktopModel ?? null,
          })
        : call<Bot, BotInput>("/v1/agents", "POST", values);
    },
    onSuccess: after,
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => call<Bot>(`${agentPath(id)}/duplicate`, "POST"),
    onSuccess: async (copy) => {
      await queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
      await navigate({ to: "/bots/$botId/edit", params: { botId: copy.id } });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => send(agentPath(id), "DELETE"),
    onSuccess: async (_, id) => {
      queryClient.removeQueries({ queryKey: ["chat", id] });
      await queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
      await navigate({ to: "/" });
    },
  });

  return { save, duplicate, remove };
}

function AvatarPicker({
  id,
  avatar,
  onChange,
}: {
  id: string;
  avatar: string;
  onChange: (avatar: string) => void;
}) {
  const { seed, choice: picked } = parseAvatar({ id, avatar });
  const look = lookOf({ id, avatar });

  const pick = (change: AvatarChoice) =>
    onChange(formatAvatar(seed, { ...picked, ...change }));

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Change avatar"
            className="group relative shrink-0 rounded-3xl p-1 transition-[scale] outline-none active:scale-[0.96] focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <BotAvatar bot={{ id, avatar }} size={96} live />
        <span className="absolute -right-1 -bottom-1 grid size-8 place-items-center rounded-full bg-background text-muted-foreground shadow-sm ring-1 ring-foreground/10 transition-colors group-hover:text-foreground">
          <HugeiconsIcon icon={PencilEdit01Icon} className="size-4" />
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Body
          </span>
          <div className="flex gap-1">
            {SILHOUETTES.map((silhouette) => (
              <button
                key={silhouette}
                type="button"
                aria-label={`${silhouette} body`}
                aria-pressed={look.silhouette === silhouette}
                className={cn(
                  "rounded-xl p-1 transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
                  look.silhouette === silhouette && "bg-muted ring-2 ring-ring",
                )}
                onClick={() => pick({ silhouette })}
              >
                <BotAvatar
                  bot={{
                    id,
                    avatar: formatAvatar(seed, { ...picked, silhouette }),
                  }}
                  size={32}
                />
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Color
          </span>
          <div className="flex gap-2 px-1">
            {PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Color ${color}`}
                aria-pressed={look.hex === color}
                className={cn(
                  "size-7 rounded-full ring-offset-2 ring-offset-popover transition-transform outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/50",
                  look.hex === color && "ring-2 ring-ring",
                )}
                style={{ backgroundColor: color }}
                onClick={() => pick({ color })}
              />
            ))}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            onChange(
              formatAvatar(randomId(), {
                silhouette: look.silhouette,
                color: look.hex,
              }),
            )
          }
        >
          <HugeiconsIcon icon={ShuffleIcon} data-icon="inline-start" />
          New face
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function DesktopModelFields({
  providers,
  access,
}: {
  providers: Provider[];
  access: ReturnType<typeof useBotAccess>;
}) {
  const { desktopProvider, setDesktopProvider, desktopModel, setDesktopModel } =
    access;

  return (
    <div className="grid gap-4 bg-muted/30 py-3 pr-3 pl-8 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor="desktop-provider">Desktop job provider</FieldLabel>
        <ProviderSelect
          id="desktop-provider"
          providers={providers}
          value={desktopProvider}
          placeholder="Same as the bot"
          onChange={(next) => {
            setDesktopProvider(next);
            setDesktopModel("");
          }}
        />
      </Field>
      {desktopProvider && (
        <Field>
          <FieldLabel htmlFor="desktop-model">Desktop job model</FieldLabel>
          <ModelField
            id="desktop-model"
            provider={desktopProvider}
            configured={isConfigured(providers, desktopProvider)}
            value={desktopModel}
            onChange={setDesktopModel}
          />
        </Field>
      )}
    </div>
  );
}

function CapabilitiesSection({
  bot,
  capabilities,
  providers,
  access,
}: {
  bot: Bot | undefined;
  capabilities: Capabilities | undefined;
  providers: Provider[];
  access: ReturnType<typeof useBotAccess>;
}) {
  const { tools, setTools } = access;
  const has = (tool: string) => tools.includes(tool);

  const shownCapabilities = CAPABILITIES.filter(
    ({ tool }) =>
      (tool !== "coding" && tool !== "desktop") ||
      capabilities?.[tool] ||
      bot?.tools.includes(tool),
  );

  return (
    <DisclosureRow
      title="Capabilities"
      summary={`${shownCapabilities.filter(({ tool }) => has(tool)).length} of ${shownCapabilities.length} on`}
    >
      {shownCapabilities.map((capability) => (
        <Fragment key={capability.tool}>
          <ToggleRow
            id={`tool-${capability.tool}`}
            label={capability.label}
            description={capability.help}
            checked={has(capability.tool)}
            onChange={(on) => setTools(toggle(tools, capability.tool, on))}
          />
          {capability.tool === "desktop" && has("desktop") && (
            <DesktopModelFields providers={providers} access={access} />
          )}
        </Fragment>
      ))}
    </DisclosureRow>
  );
}

function IntegrationsSection({
  bot,
  servers,
  value,
  onChange,
}: {
  bot: Bot | undefined;
  servers: McpServer[];
  value: string[];
  onChange: (servers: string[]) => void;
}) {
  const usableServers = servers.filter(
    (server) => server.agentId === null || server.agentId === bot?.id,
  );

  return (
    <DisclosureRow
      title="Integrations"
      summary={
        usableServers.length === 0
          ? "None set up"
          : `${usableServers.filter((server) => value.includes(server.id)).length} of ${usableServers.length} on`
      }
    >
      {usableServers.map((server) => (
        <ToggleRow
          key={server.id}
          id={`mcp-${server.id}`}
          label={
            <>
              {server.name}
              {server.agentId && <Badge variant="outline">Only this bot</Badge>}
              {!server.enabled && <Badge variant="outline">Off</Badge>}
            </>
          }
          description={server.url}
          disabled={!server.enabled}
          checked={value.includes(server.id)}
          onChange={(on) => onChange(toggle(value, server.id, on))}
        />
      ))}
      {usableServers.length === 0 && (
        <p className="p-3 text-sm text-muted-foreground">
          Add an MCP server under{" "}
          <Link to="/settings/integrations" className="underline">
            Integrations
          </Link>{" "}
          to give bots its tools.
        </p>
      )}
    </DisclosureRow>
  );
}

function ModelSettings({
  providers,
  selection,
}: {
  providers: Provider[];
  selection: ReturnType<typeof useBotModel>;
}) {
  const {
    provider,
    setProvider,
    model,
    setModel,
    levels,
    level,
    setThinkingLevel,
  } = selection;

  return (
    <FieldSet>
      <FieldLegend className="sr-only">Model</FieldLegend>
      <FieldGroup
        className={cn(
          "grid gap-4",
          levels.length > 1 ? "sm:grid-cols-[1fr_1fr_9rem]" : "sm:grid-cols-2",
        )}
      >
        <Field>
          <FieldLabel htmlFor="provider">Provider</FieldLabel>
          <ProviderSelect
            id="provider"
            providers={providers}
            value={provider}
            placeholder="Choose a provider"
            onChange={(next) => {
              setProvider(next);
              setModel("");
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="model">Model</FieldLabel>
          <ModelField
            id="model"
            provider={provider}
            configured={isConfigured(providers, provider)}
            value={model}
            onChange={setModel}
          />
        </Field>
        {levels.length > 1 && (
          <Field>
            <FieldLabel htmlFor="thinking-level">Reasoning</FieldLabel>
            <ReasoningSelect
              id="thinking-level"
              levels={levels}
              value={level}
              onChange={setThinkingLevel}
            />
          </Field>
        )}
      </FieldGroup>
    </FieldSet>
  );
}

function BotFormActions({
  bot,
  disabled,
}: {
  bot: Bot | undefined;
  disabled: boolean;
}) {
  const navigate = useNavigate();

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() =>
          void (bot
            ? navigate({ to: "/bots/$botId", params: { botId: bot.id } })
            : navigate({ to: "/" }))
        }
      >
        Cancel
      </Button>
      <Button type="submit" form="bot-form" size="sm" disabled={disabled}>
        {bot ? "Save" : "Create bot"}
      </Button>
    </>
  );
}

function BotIdentityFields({
  bot,
  details,
  failed,
}: {
  bot: Bot | undefined;
  details: ReturnType<typeof useBotDetails>;
  failed: boolean;
}) {
  const { avatar, setAvatar, name, setName, description, setDescription } =
    details;

  return (
    <div className="flex items-start gap-6">
      <AvatarPicker id={bot?.id ?? ""} avatar={avatar} onChange={setAvatar} />

      <FieldGroup className="flex-1 gap-4">
        <Field data-invalid={(failed && !name.trim()) || undefined}>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="description">Description</FieldLabel>
          <Input
            id="description"
            maxLength={1000}
            placeholder="What this bot is for"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </FieldGroup>
    </div>
  );
}

function BotManagementActions({
  bot,
  duplicate,
  remove,
}: {
  bot: Bot | undefined;
  duplicate: ReturnType<typeof useBotMutations>["duplicate"];
  remove: ReturnType<typeof useBotMutations>["remove"];
}) {
  return (
    <>
      {duplicate.isError && <FieldError>{duplicate.error.message}</FieldError>}

      <div className="flex flex-wrap items-center gap-2">
        {bot && (
          <>
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  />
                }
              >
                Delete
              </AlertDialogTrigger>
              <ConfirmDeleteContent
                title={`Delete ${bot.name}?`}
                description="The bot, its chat, memories and tasks will be removed. This cannot be undone."
                error={remove.error}
                pending={remove.isPending}
                onConfirm={() => remove.mutate(bot.id)}
              />
            </AlertDialog>
            <Button
              type="button"
              variant="outline"
              disabled={duplicate.isPending}
              onClick={() => duplicate.mutate(bot.id)}
            >
              <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
              Duplicate
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function botInput(
  bot: Bot | undefined,
  details: ReturnType<typeof useBotDetails>,
  selection: ReturnType<typeof useBotModel>,
  access: ReturnType<typeof useBotAccess>,
): BotInput {
  const { avatar, name, description, instructions, enabled } = details;
  const { provider, model, level } = selection;
  const { tools, mcpServers, desktopProvider, desktopModel } = access;

  return {
    name: name.trim(),
    description,
    instructions,
    avatar,
    enabled,
    provider,
    model: model.trim(),
    inference: { ...bot?.inference, thinkingLevel: level },
    tools,
    mcpServers: [...mcpServers].sort(),
    desktopModel:
      desktopProvider && desktopModel.trim()
        ? { provider: desktopProvider, model: desktopModel.trim() }
        : undefined,
  };
}

/** Creates a bot, or edits `bot` when given. */
export function BotForm({ bot }: { bot?: Bot }) {
  const providers = useQuery(providersQuery).data ?? [];
  const capabilities = useQuery(capabilitiesQuery).data;
  const servers = useQuery(mcpServersQuery).data ?? [];
  const details = useBotDetails(bot);

  const { name, enabled, setEnabled, instructions, setInstructions } = details;
  const selection = useBotModel(bot, providers);
  const { provider, model } = selection;
  const access = useBotAccess(bot);
  const { mcpServers } = access;

  const { save, duplicate, remove } = useBotMutations(bot, () =>
    botInput(bot, details, selection, access),
  );

  const invalid = !name.trim() || !provider || !model.trim();

  return (
    <WorkspacePage
      title={bot ? `Edit ${bot.name}` : "New bot"}
      actions={
        <BotFormActions bot={bot} disabled={invalid || save.isPending} />
      }
    >
      <form
        id="bot-form"
        className="flex flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();

          if (!invalid) save.mutate();
        }}
      >
        <BotIdentityFields bot={bot} details={details} failed={save.isError} />

        <ModelSettings providers={providers} selection={selection} />

        <Field>
          <FieldLabel htmlFor="instructions">Instructions</FieldLabel>
          <Textarea
            id="instructions"
            className="min-h-32"
            maxLength={32000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>

        <div className="flex flex-col divide-y rounded-lg border">
          <CapabilitiesSection
            bot={bot}
            capabilities={capabilities}
            providers={providers}
            access={access}
          />
          <IntegrationsSection
            bot={bot}
            servers={servers}
            value={mcpServers}
            onChange={access.setMcpServers}
          />
          <Link
            to="/settings/skills"
            className="flex items-center justify-between gap-4 p-3 text-sm transition-colors hover:bg-muted/50"
          >
            <span className="font-medium">Skills</span>
            <span className="flex items-center gap-1 text-muted-foreground">
              Manage in Settings
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" />
            </span>
          </Link>
          {bot && (
            <Link
              to="/bots/$botId/credentials"
              params={{ botId: bot.id }}
              className="flex items-center justify-between gap-4 p-3 text-sm transition-colors hover:bg-muted/50"
            >
              <span className="font-medium">Credentials</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                For coding jobs
                <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" />
              </span>
            </Link>
          )}
          <Field orientation="horizontal" className="p-3">
            <FieldContent>
              <FieldLabel htmlFor="enabled">Enabled</FieldLabel>
              <FieldDescription>
                A paused bot keeps its chat but takes no new work. Pausing stops
                what it is doing.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </Field>
        </div>

        {save.isError && <FieldError>{save.error.message}</FieldError>}
        <BotManagementActions bot={bot} duplicate={duplicate} remove={remove} />
      </form>
    </WorkspacePage>
  );
}

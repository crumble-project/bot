import { Fragment, type ReactNode, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  IconChevronDown,
  IconChevronRight,
  IconPencil,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
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
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn, randomId } from "@/lib/utils";
import {
  type Bot,
  type BotInput,
  type Capabilities,
  capabilitiesQuery,
} from "./api";
import { type McpServer, mcpServersQuery } from "@/features/integrations/api";
import {
  type Provider,
  modelsQuery,
  providersQuery,
} from "@/features/providers/api";
import { BotAvatar } from "@/components/bot-avatar";
import {
  isWebSearchProviderId,
  webSearchProviders,
} from "@/features/web-search/web-search";
import { SelectOptions } from "@/components/form-fields";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";
import { AvatarEditor } from "@/features/avatars/avatar-editor";
import { CAPABILITIES } from "./capabilities";
import {
  type ThinkingLevel,
  ReasoningSelect,
  clampLevel,
  levelsOf,
} from "./reasoning";
import { BOT_TOOL } from "@crumble/server/contract/tools";
import {
  MAX_BOT_DESCRIPTION_CHARS,
  MAX_BOT_NAME_CHARS,
  MAX_INSTRUCTIONS_CHARS,
} from "@crumble/server/contract/limits";
import { agentInput } from "@crumble/server/contract/agents";

const DEFAULT_TOOLS: string[] = [
  BOT_TOOL.memory,
  BOT_TOOL.web,
  BOT_TOOL.delegate,
];

const DEFAULT_INSTRUCTIONS = agentInput.shape.instructions.parse(undefined);

const webProviderItems = [
  { label: "Account default", value: "default" },
  ...webSearchProviders.map(({ id, name }) => ({ label: name, value: id })),
];

function providerItems(providers: Provider[], current: string) {
  const items = providers.flatMap((each) =>
    each.configured ? [{ label: each.name, value: each.provider }] : [],
  );

  if (!current || items.some((item) => item.value === current)) return items;

  const name = providers.find((each) => each.provider === current)?.name;

  return [
    { label: `${name ?? current} (not set up)`, value: current },
    ...items,
  ];
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
      <SelectOptions items={items} />
    </Select>
  );
}

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
          {open ? (
            <IconChevronDown className="size-4" />
          ) : (
            <IconChevronRight className="size-4" />
          )}
        </span>
      </button>
      {open && <div className="flex flex-col divide-y">{children}</div>}
    </div>
  );
}

function initialDetails(
  {
    avatar,
    name = "",
    description = "",
    enabled = true,
    instructions = DEFAULT_INSTRUCTIONS,
  }: Partial<BotInput> = {},
  botId?: string,
) {
  return {
    avatar: avatar ?? defaultAvatarDefinition(botId || randomId()),
    name,
    description,
    enabled,
    instructions,
  };
}

function useBotDetails(
  initial: BotInput | undefined,
  botId: string | undefined,
) {
  const [details, setDetails] = useState(() => initialDetails(initial, botId));

  const change = (next: Partial<typeof details>) =>
    setDetails((current) => ({ ...current, ...next }));

  return { ...details, change };
}

function useBotModel(initial: BotInput | undefined, providers: Provider[]) {
  const [provider, setProvider] = useState(
    initial?.provider ??
      providers.find((each) => each.configured)?.provider ??
      "",
  );

  const [model, setModel] = useState(initial?.model ?? "");

  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    initial?.inference?.thinkingLevel ?? "off",
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

function initialAccess({
  tools = DEFAULT_TOOLS,
  mcpServers = [],
  webSearchProvider = null,
  desktopModel,
}: Partial<BotInput> = {}) {
  return {
    tools,
    mcpServers,
    webSearchProvider,
    desktopProvider: desktopModel?.provider ?? "",
    desktopModel: desktopModel?.model ?? "",
  };
}

function useBotAccess(initial?: BotInput) {
  const start = initialAccess(initial);
  const [tools, setTools] = useState<string[]>(start.tools);
  const [mcpServers, setMcpServers] = useState<string[]>(start.mcpServers);

  const [webSearchProvider, setWebSearchProvider] = useState(
    start.webSearchProvider,
  );

  const [desktopProvider, setDesktopProvider] = useState(start.desktopProvider);
  const [desktopModel, setDesktopModel] = useState(start.desktopModel);

  return {
    tools,
    setTools,
    mcpServers,
    setMcpServers,
    webSearchProvider,
    setWebSearchProvider,
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

function AvatarPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Bot["avatar"];
  onChange: (value: Bot["avatar"]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Change avatar"
            className="relative shrink-0 rounded-3xl p-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <BotAvatar bot={{ id, avatar: value }} size={96} live />
        <span className="absolute -right-1 -bottom-1 rounded-full bg-background p-2">
          <IconPencil className="size-4" />
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[80dvh] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto"
      >
        <AvatarEditor value={value} onChange={onChange} />
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
  initial,
  capabilities,
  providers,
  access,
}: {
  initial: BotInput | undefined;
  capabilities: Capabilities | undefined;
  providers: Provider[];
  access: ReturnType<typeof useBotAccess>;
}) {
  const { tools, setTools } = access;
  const has = (tool: string) => tools.includes(tool);

  const shownCapabilities = CAPABILITIES.filter(
    ({ tool }) =>
      (tool !== BOT_TOOL.coding && tool !== BOT_TOOL.desktop) ||
      capabilities?.[tool] ||
      initial?.tools?.includes(tool),
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
          {capability.tool === BOT_TOOL.desktop && has(BOT_TOOL.desktop) && (
            <DesktopModelFields providers={providers} access={access} />
          )}
        </Fragment>
      ))}
    </DisclosureRow>
  );
}

function IntegrationsSection({
  botId,
  servers,
  value,
  onChange,
}: {
  botId: string | undefined;
  servers: McpServer[];
  value: string[];
  onChange: (servers: string[]) => void;
}) {
  const usableServers = servers.filter(
    (server) => server.agentId === null || server.agentId === botId,
  );

  const on = new Set(value);

  return (
    <DisclosureRow
      title="Integrations"
      summary={
        usableServers.length === 0
          ? "None set up"
          : `${usableServers.filter((server) => on.has(server.id)).length} of ${usableServers.length} on`
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
          checked={on.has(server.id)}
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

function ProviderField({
  providers,
  selection: { provider, setProvider, setModel },
}: {
  providers: Provider[];
  selection: ReturnType<typeof useBotModel>;
}) {
  return (
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
      {!providers.some((each) => each.configured) && (
        <FieldDescription>
          No provider is set up yet.{" "}
          <Link to="/settings/providers" className="underline">
            Add one in Settings
          </Link>
          .
        </FieldDescription>
      )}
    </Field>
  );
}

function ModelSettings({
  providers,
  selection,
}: {
  providers: Provider[];
  selection: ReturnType<typeof useBotModel>;
}) {
  const { provider, model, setModel, levels, level, setThinkingLevel } =
    selection;

  return (
    <FieldSet>
      <FieldLegend className="sr-only">Model</FieldLegend>
      <FieldGroup
        className={cn(
          "grid gap-4",
          levels.length > 1 ? "sm:grid-cols-[1fr_1fr_9rem]" : "sm:grid-cols-2",
        )}
      >
        <ProviderField providers={providers} selection={selection} />
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

function BotIdentityFields({
  botId,
  details,
  failed,
}: {
  botId: string | undefined;
  details: ReturnType<typeof useBotDetails>;
  failed: boolean;
}) {
  const { avatar, name, description, change } = details;

  return (
    <div className="flex items-start gap-6">
      <AvatarPicker
        id={botId ?? ""}
        value={avatar}
        onChange={(next) => change({ avatar: next })}
      />

      <FieldGroup className="flex-1 gap-4">
        <Field data-invalid={(failed && !name.trim()) || undefined}>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            required
            maxLength={MAX_BOT_NAME_CHARS}
            value={name}
            onChange={(event) => change({ name: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="description">Description</FieldLabel>
          <Input
            id="description"
            maxLength={MAX_BOT_DESCRIPTION_CHARS}
            placeholder="What this bot is for"
            value={description}
            onChange={(event) => change({ description: event.target.value })}
          />
        </Field>
      </FieldGroup>
    </div>
  );
}

function botInput(
  initial: BotInput | undefined,
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
    inference: { ...initial?.inference, thinkingLevel: level },
    tools,
    webSearchProvider: access.webSearchProvider,
    mcpServers: [...mcpServers].sort(),
    desktopModel:
      desktopProvider && desktopModel.trim()
        ? { provider: desktopProvider, model: desktopModel.trim() }
        : undefined,
  };
}

function BotSettingsLinks({ botId }: { botId: string | undefined }) {
  return (
    <>
      <Link
        to="/settings/skills"
        className="flex items-center justify-between gap-4 p-3 text-sm transition-colors hover:bg-muted/50"
      >
        <span className="font-medium">Skills</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          Manage in Settings <IconChevronRight className="size-4" />
        </span>
      </Link>
      {botId && (
        <Link
          to="/settings/credentials"
          search={{ bot: botId }}
          className="flex items-center justify-between gap-4 p-3 text-sm transition-colors hover:bg-muted/50"
        >
          <span className="font-medium">Credentials</span>
          <span className="flex items-center gap-1 text-muted-foreground">
            Manage in Settings <IconChevronRight className="size-4" />
          </span>
        </Link>
      )}
    </>
  );
}

function BotEnabledField({
  formId,
  enabled,
  onEnabledChange,
}: {
  formId: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="p-3">
      <FieldContent>
        <FieldLabel htmlFor={`${formId}-enabled`}>Enabled</FieldLabel>
        <FieldDescription>
          A paused bot keeps its chat but takes no new work. Pausing stops what
          it is doing.
        </FieldDescription>
      </FieldContent>
      <Switch
        id={`${formId}-enabled`}
        checked={enabled}
        onCheckedChange={onEnabledChange}
      />
    </Field>
  );
}

function InstructionsField({
  formId,
  details,
}: {
  formId: string;
  details: ReturnType<typeof useBotDetails>;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={`${formId}-instructions`}>Instructions</FieldLabel>
      <Textarea
        id={`${formId}-instructions`}
        className="min-h-32"
        maxLength={MAX_INSTRUCTIONS_CHARS}
        value={details.instructions}
        onChange={(event) =>
          details.change({ instructions: event.target.value })
        }
      />
    </Field>
  );
}

function WebSearchProviderField({
  formId,
  access,
}: {
  formId: string;
  access: ReturnType<typeof useBotAccess>;
}) {
  return (
    <Field className="p-3">
      <FieldLabel htmlFor={`${formId}-web-provider`}>
        Web search provider
      </FieldLabel>
      <Select
        items={webProviderItems}
        value={access.webSearchProvider ?? "default"}
        onValueChange={(value) =>
          access.setWebSearchProvider(
            value && isWebSearchProviderId(value) ? value : null,
          )
        }
      >
        <SelectTrigger id={`${formId}-web-provider`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectOptions items={webProviderItems} />
      </Select>
      <FieldDescription>
        Manage the default and Exa key in Settings → Web search.
      </FieldDescription>
    </Field>
  );
}

function BotFieldSections({
  initial,
  botId,
  formId,
  details,
  selection,
  access,
  providers,
  capabilities,
  servers,
  includeSettingsLinks,
  failed,
}: {
  initial: BotInput | undefined;
  botId: string | undefined;
  formId: string;
  details: ReturnType<typeof useBotDetails>;
  selection: ReturnType<typeof useBotModel>;
  access: ReturnType<typeof useBotAccess>;
  providers: Provider[];
  capabilities: Capabilities | undefined;
  servers: McpServer[];
  includeSettingsLinks: boolean;
  failed: boolean;
}) {
  return (
    <>
      <BotIdentityFields botId={botId} details={details} failed={failed} />
      <ModelSettings providers={providers} selection={selection} />
      <InstructionsField formId={formId} details={details} />
      <div className="flex flex-col divide-y rounded-lg border">
        <CapabilitiesSection
          initial={initial}
          capabilities={capabilities}
          providers={providers}
          access={access}
        />
        {access.tools.includes(BOT_TOOL.web) && (
          <WebSearchProviderField formId={formId} access={access} />
        )}
        <IntegrationsSection
          botId={botId}
          servers={servers}
          value={access.mcpServers}
          onChange={access.setMcpServers}
        />
        {includeSettingsLinks && <BotSettingsLinks botId={botId} />}
        <BotEnabledField
          formId={formId}
          enabled={details.enabled}
          onEnabledChange={(enabled) => details.change({ enabled })}
        />
      </div>
    </>
  );
}

export function useBotFields(initial?: BotInput, botId?: string) {
  const providers = useQuery(providersQuery).data ?? [];
  const details = useBotDetails(initial, botId);
  const selection = useBotModel(initial, providers);
  const access = useBotAccess(initial);

  const invalid =
    !details.name.trim() || !selection.provider || !selection.model.trim();

  return { initial, botId, providers, details, selection, access, invalid };
}

export function BotFields({
  fields: { initial, botId, providers, details, selection, access, invalid },
  onSubmit,
  formId,
  failed = false,
  includeSettingsLinks = false,
}: {
  fields: ReturnType<typeof useBotFields>;
  onSubmit: (input: BotInput) => void;
  formId: string;
  failed?: boolean;
  includeSettingsLinks?: boolean;
}) {
  const capabilities = useQuery(capabilitiesQuery).data;
  const servers = useQuery(mcpServersQuery).data ?? [];

  return (
    <form
      id={formId}
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();

        if (!invalid) onSubmit(botInput(initial, details, selection, access));
      }}
    >
      <BotFieldSections
        initial={initial}
        botId={botId}
        formId={formId}
        details={details}
        selection={selection}
        access={access}
        providers={providers}
        capabilities={capabilities}
        servers={servers}
        includeSettingsLinks={includeSettingsLinks}
        failed={failed}
      />
    </form>
  );
}

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, ShuffleIcon } from "@hugeicons/core-free-icons";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
} from "./api";
import { BotAvatar } from "./avatar";
import {
  type ThinkingLevel,
  ReasoningSelect,
  clampLevel,
  levelsOf,
} from "./reasoning";

const CAPABILITIES = [
  { tool: "memory", label: "Memory", help: "Remembers facts across chats." },
  { tool: "schedule", label: "Schedule tasks", help: "Plans its own tasks." },
  {
    tool: "delegate",
    label: "Message other bots",
    help: "Asks the bots you allow for help.",
  },
  {
    tool: "codemode",
    label: "Code mode",
    help: "Combines tool calls in code.",
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

const DEFAULT_TOOLS = ["memory", "delegate", "schedule", "codemode"];

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

/** Creates a bot, or edits `bot` when given. */
export function BotForm({ bot }: { bot?: Bot }) {
  const navigate = useNavigate();
  const bots = useQuery(botsQuery).data ?? [];
  const providers = useQuery(providersQuery).data ?? [];
  const capabilities = useQuery(capabilitiesQuery).data;
  const servers = useQuery(mcpServersQuery).data ?? [];
  const others = bots.filter((each) => each.id !== bot?.id);

  const [avatar, setAvatar] = useState(bot?.avatar ?? seedAvatar());

  const [choices, setChoices] = useState(() =>
    Array.from({ length: 6 }, seedAvatar),
  );

  const [name, setName] = useState(bot?.name ?? "");
  const [description, setDescription] = useState(bot?.description ?? "");
  const [enabled, setEnabled] = useState(bot?.enabled ?? true);

  const [instructions, setInstructions] = useState(
    bot?.instructions ?? DEFAULT_INSTRUCTIONS,
  );

  const [provider, setProvider] = useState(
    bot?.provider ?? providers.find((each) => each.configured)?.provider ?? "",
  );

  const [model, setModel] = useState(bot?.model ?? "");

  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    bot?.inference?.thinkingLevel ?? "off",
  );

  const [tools, setTools] = useState<string[]>(bot?.tools ?? DEFAULT_TOOLS);
  const [sharedMemory, setSharedMemory] = useState(bot?.sharedMemory ?? false);

  const [delegates, setDelegates] = useState<string[]>(
    bot?.delegates ?? bots.map((each) => each.id),
  );

  const [mcpServers, setMcpServers] = useState<string[]>(bot?.mcpServers ?? []);

  const [desktopProvider, setDesktopProvider] = useState(
    bot?.desktopModel?.provider ?? "",
  );

  const [desktopModel, setDesktopModel] = useState(
    bot?.desktopModel?.model ?? "",
  );

  const models = useQuery({
    ...modelsQuery(provider),
    enabled: provider !== "",
  }).data;

  const levels = levelsOf(models?.find((each) => each.id === model.trim()));
  const level = clampLevel(thinkingLevel, levels);

  const has = (tool: string) => tools.includes(tool);

  const toggle = (list: string[], item: string, on: boolean) =>
    on ? [...new Set([...list, item])] : list.filter((each) => each !== item);

  const shownCapabilities = CAPABILITIES.filter(
    ({ tool }) =>
      (tool !== "coding" && tool !== "desktop") ||
      capabilities?.[tool] ||
      bot?.tools.includes(tool),
  );

  const usableServers = servers.filter(
    (server) => server.agentId === null || server.agentId === bot?.id,
  );

  const configured = (id: string) =>
    providers.find((each) => each.provider === id)?.configured ?? false;

  const after = async (saved: Bot) => {
    await queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
    await navigate({ to: "/bots/$botId", params: { botId: saved.id } });
  };

  const save = useMutation({
    mutationFn: () => {
      const input: BotInput = {
        name: name.trim(),
        description,
        instructions,
        avatar,
        enabled,
        provider,
        model: model.trim(),
        inference: { ...bot?.inference, thinkingLevel: level },
        tools,
        sharedMemory,
        delegates: [...delegates].sort(),
        mcpServers: [...mcpServers].sort(),
        desktopModel:
          desktopProvider && desktopModel.trim()
            ? { provider: desktopProvider, model: desktopModel.trim() }
            : undefined,
      };

      return bot
        ? call<
            Bot,
            BotInput & { desktopModel: BotInput["desktopModel"] | null }
          >(agentPath(bot.id), "PATCH", {
            ...input,
            desktopModel: input.desktopModel ?? null,
          })
        : call<Bot, BotInput>("/v1/agents", "POST", input);
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

  const invalid = !name.trim() || !provider || !model.trim();

  return (
    <div className="flex-1 overflow-y-auto">
      <form
        className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-6"
        onSubmit={(event) => {
          event.preventDefault();

          if (!invalid) save.mutate();
        }}
      >
        <FieldSet>
          <FieldLegend>{bot ? `Edit ${bot.name}` : "New bot"}</FieldLegend>
          <FieldGroup>
            <Field>
              <FieldLabel>Avatar</FieldLabel>
              <div className="flex flex-col items-center gap-3">
                <BotAvatar bot={{ id: bot?.id ?? "", avatar }} size={96} live />
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  {[avatar, ...choices.filter((each) => each !== avatar)]
                    .slice(0, 7)
                    .map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        aria-label="Choose this avatar"
                        aria-pressed={choice === avatar}
                        className={cn(
                          "rounded-lg border-2 border-transparent p-0.5",
                          choice === avatar && "border-ring",
                        )}
                        onClick={() => setAvatar(choice)}
                      >
                        <BotAvatar
                          bot={{ id: bot?.id ?? "", avatar: choice }}
                          size={36}
                        />
                      </button>
                    ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="More avatars"
                    onClick={() =>
                      setChoices(Array.from({ length: 6 }, seedAvatar))
                    }
                  >
                    <HugeiconsIcon icon={ShuffleIcon} />
                  </Button>
                </div>
              </div>
            </Field>
            <Field data-invalid={(save.isError && !name.trim()) || undefined}>
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
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="enabled">Enabled</FieldLabel>
                <FieldDescription>
                  A paused bot keeps its chat but takes no new work. Pausing
                  stops what it is doing.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </Field>
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldLegend variant="label">Model</FieldLegend>
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
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
                configured={configured(provider)}
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
                <FieldDescription>
                  How much the model thinks before it answers.
                </FieldDescription>
              </Field>
            )}
          </FieldGroup>
        </FieldSet>

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

        <FieldSet>
          <FieldLegend variant="label">Capabilities</FieldLegend>
          <FieldGroup>
            {shownCapabilities.map((capability) => (
              <div key={capability.tool} className="flex flex-col gap-3">
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor={`tool-${capability.tool}`}>
                      {capability.label}
                    </FieldLabel>
                    <FieldDescription>{capability.help}</FieldDescription>
                  </FieldContent>
                  <Switch
                    id={`tool-${capability.tool}`}
                    checked={has(capability.tool)}
                    onCheckedChange={(on) =>
                      setTools(toggle(tools, capability.tool, on))
                    }
                  />
                </Field>
                {capability.tool === "memory" && has("memory") && (
                  <Field orientation="horizontal" className="pl-6">
                    <FieldLabel htmlFor="shared-memory">
                      Use shared memory
                    </FieldLabel>
                    <Switch
                      id="shared-memory"
                      size="sm"
                      checked={sharedMemory}
                      onCheckedChange={setSharedMemory}
                    />
                  </Field>
                )}
                {capability.tool === "delegate" &&
                  has("delegate") &&
                  others.map((other) => (
                    <Field
                      key={other.id}
                      orientation="horizontal"
                      className="pl-6"
                    >
                      <FieldLabel
                        htmlFor={`delegate-${other.id}`}
                        className="flex items-center gap-2"
                      >
                        <BotAvatar bot={other} size={22} />
                        {other.name}
                      </FieldLabel>
                      <Switch
                        id={`delegate-${other.id}`}
                        size="sm"
                        checked={delegates.includes(other.id)}
                        onCheckedChange={(on) =>
                          setDelegates(toggle(delegates, other.id, on))
                        }
                      />
                    </Field>
                  ))}
                {capability.tool === "desktop" && has("desktop") && (
                  <div className="grid gap-4 pl-6 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="desktop-provider">
                        Desktop job provider
                      </FieldLabel>
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
                        <FieldLabel htmlFor="desktop-model">
                          Desktop job model
                        </FieldLabel>
                        <ModelField
                          id="desktop-model"
                          provider={desktopProvider}
                          configured={configured(desktopProvider)}
                          value={desktopModel}
                          onChange={setDesktopModel}
                        />
                      </Field>
                    )}
                  </div>
                )}
              </div>
            ))}
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldLegend variant="label">Integrations</FieldLegend>
          <FieldGroup>
            {usableServers.map((server) => (
              <Field
                key={server.id}
                orientation="horizontal"
                data-disabled={!server.enabled || undefined}
              >
                <FieldContent>
                  <FieldLabel htmlFor={`mcp-${server.id}`}>
                    {server.name}
                    {server.agentId && (
                      <Badge variant="outline">Only this bot</Badge>
                    )}
                    {!server.enabled && <Badge variant="outline">Off</Badge>}
                  </FieldLabel>
                  <FieldDescription className="truncate">
                    {server.url}
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id={`mcp-${server.id}`}
                  disabled={!server.enabled}
                  checked={mcpServers.includes(server.id)}
                  onCheckedChange={(on) =>
                    setMcpServers(toggle(mcpServers, server.id, on))
                  }
                />
              </Field>
            ))}
            {usableServers.length === 0 && (
              <FieldDescription>
                Add an MCP server under{" "}
                <Link to="/settings/integrations" className="underline">
                  Integrations
                </Link>{" "}
                to give bots its tools.
              </FieldDescription>
            )}
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldLegend variant="label">Skills</FieldLegend>
          <FieldDescription>
            Skills teach bots how to do specific things. Manage shared and
            personal skills in{" "}
            <Link to="/settings/skills" className="underline">
              Skills
            </Link>
            .
          </FieldDescription>
        </FieldSet>

        <FieldSeparator />

        {save.isError && <FieldError>{save.error.message}</FieldError>}
        {duplicate.isError && (
          <FieldError>{duplicate.error.message}</FieldError>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {bot && (
            <>
              <AlertDialog>
                <AlertDialogTrigger
                  render={<Button type="button" variant="destructive" />}
                >
                  Delete
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The bot, its chat, memories and tasks will be removed.
                      This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {remove.isError && (
                    <FieldError>{remove.error.message}</FieldError>
                  )}
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(bot.id)}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
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
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                void (bot
                  ? navigate({ to: "/bots/$botId", params: { botId: bot.id } })
                  : navigate({ to: "/" }))
              }
            >
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || save.isPending}>
              {bot ? "Save" : "Create bot"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

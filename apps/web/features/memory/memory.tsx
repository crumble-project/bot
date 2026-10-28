import { type ReactNode, useState } from "react";
import {
  type UseQueryResult,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import {
  IconCalendarRepeat,
  IconMessage,
  IconPlus,
  IconRobot,
  IconSearch,
  IconTrash,
  IconUser,
  IconUsersGroup,
  type TablerIcon,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { EditorSheet, OwnerSelectField } from "@/components/form-fields";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type Bot,
  type Memory,
  agentPath,
  botMemoriesQuery,
  botsQuery,
  queryClient,
  send,
  sharedMemoriesQuery,
} from "@/lib/api";
import { BotAvatar } from "@/features/bots/avatar";
import {
  ConfirmDelete,
  SectionEmpty,
  WorkspacePage,
} from "@/components/workspace";

const SHARED = "shared";
const ALL = "all";

type Editing = { memory: Memory | null; owner: string };

function memoryPath(owner: string, id?: string) {
  const base =
    owner === SHARED ? "/v1/memories" : `${agentPath(owner)}/memories`;

  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

const SOURCE_LABELS: Record<
  NonNullable<Memory["source"]>["kind"],
  (name: string | undefined) => string
> = {
  chat: () => "From the bot chat",
  owner: () => "Added by you",
  task: (name) => `From the automation ${name ?? ""}`.trim(),
  bot: (name) => `From a request by ${name ?? "a bot"}`,
  group: (name) => `From the group chat ${name ?? ""}`.trim(),
};

export function sourceLabel(memory: Memory) {
  const source = memory.source;

  return source ? SOURCE_LABELS[source.kind](source.name) : null;
}

const SOURCE_ICONS = {
  chat: IconMessage,
  owner: IconUser,
  task: IconCalendarRepeat,
  bot: IconRobot,
  group: IconUsersGroup,
} satisfies Record<NonNullable<Memory["source"]>["kind"], TablerIcon>;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["minute", 60],
  ["hour", 60],
  ["day", 24],
  ["week", 7],
  ["month", 4.35],
  ["year", 12],
];

/** "3 days ago", in the largest unit that is at least one. */
function ago(iso: string, now: number) {
  let value = (Date.parse(iso) - now) / 1000;
  let unit: Intl.RelativeTimeFormatUnit = "second";

  for (const [next, size] of STEPS) {
    if (Math.abs(value) < size) break;

    value /= size;
    unit = next;
  }

  return unit === "second"
    ? relative.format(0, "minute")
    : relative.format(Math.round(value), unit);
}

/** The text with every case-insensitive occurrence of `needle` marked. */
function Highlighted({ text, needle }: { text: string; needle: string }) {
  if (!needle) return text;

  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;

  for (
    let at = lower.indexOf(needle);
    at !== -1;
    at = lower.indexOf(needle, from)
  ) {
    parts.push(text.slice(from, at));
    parts.push(
      <mark
        key={at}
        className="rounded-sm bg-amber-200/70 text-inherit dark:bg-amber-400/30"
      >
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }

  parts.push(text.slice(from));

  return parts;
}

type Owner = {
  id: string;
  name: string;
  bot?: Bot;
  memories: UseQueryResult<Memory[]>;
};

function OwnerPills({
  owners,
  scope,
  onScope,
}: {
  owners: Owner[];
  scope: string;
  onScope: (scope: string) => void;
}) {
  const total = owners.reduce(
    (sum, owner) => sum + (owner.memories.data?.length ?? 0),
    0,
  );

  const pills = [
    { id: ALL, name: "All", count: total, icon: null },
    ...owners.map((owner) => ({
      id: owner.id,
      name: owner.name,
      count: owner.memories.data?.length ?? 0,
      icon: owner.bot ? (
        <BotAvatar bot={owner.bot} size={18} />
      ) : (
        <IconUsersGroup />
      ),
    })),
  ];

  return (
    <div
      role="group"
      aria-label="Whose memories"
      className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
    >
      {pills.map((pill) => (
        <Button
          key={pill.id}
          type="button"
          size="sm"
          variant={scope === pill.id ? "secondary" : "ghost"}
          aria-pressed={scope === pill.id}
          className="shrink-0 rounded-full"
          onClick={() => onScope(pill.id)}
        >
          {pill.icon}
          {pill.name}
          <span className="text-muted-foreground tabular-nums">
            {pill.count}
          </span>
        </Button>
      ))}
    </div>
  );
}

function SharedUsers({ bots }: { bots: Bot[] }) {
  const users = bots.filter((bot) => bot.sharedMemory);

  if (!users.length)
    return (
      <span className="text-xs text-muted-foreground">
        No bot uses shared memory yet
      </span>
    );

  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      Used by
      <span className="flex -space-x-1.5">
        {users.map((bot) => (
          <Tooltip key={bot.id}>
            <TooltipTrigger render={<span />}>
              <BotAvatar bot={bot} size={20} />
            </TooltipTrigger>
            <TooltipContent>{bot.name}</TooltipContent>
          </Tooltip>
        ))}
      </span>
    </span>
  );
}

function MemoryRow({
  memory,
  needle,
  now,
  onEdit,
  onDelete,
}: {
  memory: Memory;
  needle: string;
  now: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const SourceIcon = memory.source ? SOURCE_ICONS[memory.source.kind] : null;

  return (
    <div className="group/memory flex items-start gap-2 px-3 py-2.5 transition-colors hover:bg-muted/50">
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onEdit}
      >
        <p className="line-clamp-3 text-sm whitespace-pre-wrap">
          <Highlighted text={memory.content} needle={needle} />
        </p>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {SourceIcon && <SourceIcon className="size-3.5 shrink-0" />}
          <span className="truncate">
            {[sourceLabel(memory), ago(memory.updatedAt, now)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </button>
      <ConfirmDelete
        title="Delete this memory?"
        description="The bot forgets it. This cannot be undone."
        onConfirm={onDelete}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            title="Delete"
            className="opacity-0 transition-opacity group-hover/memory:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          >
            <IconTrash />
          </Button>
        }
      />
    </div>
  );
}

function OwnerGroup({
  owner,
  bots,
  needle,
  onEdit,
  onDelete,
}: {
  owner: Owner;
  bots: Bot[];
  needle: string;
  onEdit: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}) {
  const all = owner.memories.data ?? [];
  const now = Date.now();

  const shown = needle
    ? all.filter((memory) => memory.content.toLowerCase().includes(needle))
    : all;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {owner.bot ? (
            <BotAvatar bot={owner.bot} size={22} />
          ) : (
            <IconUsersGroup className="size-5 text-muted-foreground" />
          )}
          {owner.name}
          <span className="font-normal text-muted-foreground tabular-nums">
            {all.length}
          </span>
        </h2>
        {!owner.bot && <SharedUsers bots={bots} />}
      </div>
      <div className="flex flex-col divide-y overflow-hidden rounded-xl border bg-muted/30">
        {owner.memories.error && (
          <SectionEmpty>{owner.memories.error.message}</SectionEmpty>
        )}
        {!owner.memories.error && shown.length === 0 && (
          <SectionEmpty>
            {all.length ? "No memories match your search." : "No memories yet."}
          </SectionEmpty>
        )}
        {shown.map((memory) => (
          <MemoryRow
            key={memory.id}
            memory={memory}
            needle={needle}
            now={now}
            onEdit={() => onEdit(memory)}
            onDelete={() => onDelete(memory)}
          />
        ))}
      </div>
    </section>
  );
}

/** Whether a group earns its frame: the one picked, shared, or a bot with matching memories. */
function groupShown(owner: Owner, scope: string, needle: string) {
  if (scope !== ALL) return scope === owner.id;

  const memories = owner.memories.data ?? [];

  if (owner.memories.isError) return true;

  if (!needle) return !owner.bot || memories.length > 0;

  return memories.some((memory) =>
    memory.content.toLowerCase().includes(needle),
  );
}

function MemoryGroups({
  owners,
  bots,
  scope,
  needle,
  onEdit,
  onDelete,
}: {
  owners: Owner[];
  bots: Bot[];
  scope: string;
  needle: string;
  onEdit: (memory: Memory, owner: string) => void;
  onDelete: (memory: Memory) => void;
}) {
  const shown = owners.filter((owner) => groupShown(owner, scope, needle));

  const empty = owners.filter(
    (owner) => owner.bot && !owner.memories.data?.length,
  );

  return (
    <>
      {shown.map((owner) => (
        <OwnerGroup
          key={owner.id}
          owner={owner}
          bots={bots}
          needle={needle}
          onEdit={(memory) => onEdit(memory, owner.id)}
          onDelete={onDelete}
        />
      ))}
      {scope === ALL && needle === "" && empty.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing remembered yet by{" "}
          {empty.map((owner) => owner.name).join(", ")}.
        </p>
      )}
      {needle !== "" && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No memories match your search.
        </p>
      )}
    </>
  );
}

function useMemoryData() {
  const bots = useQuery(botsQuery);
  const shared = useQuery(sharedMemoriesQuery);

  const perBot = useQueries({
    queries: (bots.data ?? []).map((bot) => botMemoriesQuery(bot.id)),
  });

  const owners: Owner[] = [
    { id: SHARED, name: "Shared", memories: shared },
    ...(bots.data ?? []).flatMap((bot, index) => {
      const memories = perBot[index];

      return memories ? [{ id: bot.id, name: bot.name, bot, memories }] : [];
    }),
  ];

  const refreshing =
    bots.isFetching || shared.isFetching || perBot.some((q) => q.isFetching);

  return { bots, shared, owners, refreshing };
}

function useDeleteMemory() {
  return useMutation({
    mutationFn: (memory: Memory) =>
      send(memoryPath(memory.agentId ?? SHARED, memory.id), "DELETE"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["memories"] }),
  });
}

function SearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative flex-1">
      <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        aria-label="Search memories"
        placeholder="Search memories"
        className="pl-8"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function MemoryPage() {
  const { bots, shared, owners, refreshing } = useMemoryData();
  const [scope, setScope] = useState(ALL);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const remove = useDeleteMemory();

  return (
    <WorkspacePage
      title="Memory"
      refreshing={refreshing}
      onRefresh={() =>
        void queryClient.invalidateQueries({ queryKey: ["memories"] })
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <SearchField value={search} onChange={setSearch} />
          <Button
            onClick={() =>
              setEditing({
                memory: null,
                owner: scope === ALL ? SHARED : scope,
              })
            }
          >
            <IconPlus data-icon="inline-start" />
            New memory
          </Button>
        </div>
        <OwnerPills owners={owners} scope={scope} onScope={setScope} />
      </div>
      {remove.isError && (
        <Alert variant="destructive">
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
      {bots.isPending || shared.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <MemoryGroups
          owners={owners}
          bots={bots.data ?? []}
          scope={scope}
          needle={search.trim().toLowerCase()}
          onEdit={(memory, owner) => setEditing({ memory, owner })}
          onDelete={(memory) => remove.mutate(memory)}
        />
      )}
      {editing && (
        <MemoryDialog
          bots={bots.data ?? []}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </WorkspacePage>
  );
}

function MemoryDialog({
  bots,
  editing,
  onClose,
}: {
  bots: Bot[];
  editing: Editing;
  onClose: () => void;
}) {
  const [owner, setOwner] = useState(editing.owner);
  const [content, setContent] = useState(editing.memory?.content ?? "");

  const owners = [
    { label: "Shared", value: SHARED },
    ...bots.map((bot) => ({ label: bot.name, value: bot.id })),
  ];

  const save = useMutation({
    mutationFn: () =>
      editing.memory
        ? send(memoryPath(owner, editing.memory.id), "PATCH", { content })
        : send(memoryPath(owner), "POST", { content }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memories"] });
      onClose();
    },
  });

  return (
    <EditorSheet
      title={editing.memory ? "Edit Memory" : "New Memory"}
      error={save.error?.message}
      submitLabel={editing.memory ? "Save" : "Add"}
      submitDisabled={!content.trim() || save.isPending}
      onSubmit={() => content.trim() && save.mutate()}
      onClose={onClose}
    >
      <OwnerSelectField
        label="Remembered by"
        owners={owners}
        value={owner}
        disabled={editing.memory !== null}
        onValueChange={(value) => setOwner(value ?? SHARED)}
      />
      <Field>
        <FieldLabel htmlFor="memory-content">Memory</FieldLabel>
        <Textarea
          id="memory-content"
          className="min-h-32"
          maxLength={32000}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </Field>
    </EditorSheet>
  );
}

import { type ReactNode, useState } from "react";
import {
  type UseQueryResult,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  PencilEdit01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { OwnerSelectField, SaveDialogFooter } from "@/components/form-fields";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
  Section,
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
  task: (name) => `From the task ${name ?? ""}`.trim(),
  bot: (name) => `From a request by ${name ?? "a bot"}`,
  group: (name) => `From the group chat ${name ?? ""}`.trim(),
};

export function sourceLabel(memory: Memory) {
  const source = memory.source;

  return source ? SOURCE_LABELS[source.kind](source.name) : null;
}

const inScope = (scope: string, id: string) => scope === ALL || scope === id;

function MemoryFilters({
  scopeItems,
  scope,
  search,
  onScope,
  onSearch,
}: {
  scopeItems: { label: string; value: string }[];
  scope: string;
  search: string;
  onScope: (scope: string) => void;
  onSearch: (search: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <Select
        items={scopeItems}
        value={scope}
        onValueChange={(value) => onScope(value ?? ALL)}
      >
        <SelectTrigger className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {scopeItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <div className="relative flex-1">
        <HugeiconsIcon
          icon={Search01Icon}
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search memories"
          placeholder="Search"
          className="pl-8"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
    </div>
  );
}

function MemorySections({
  bots,
  shared,
  perBot,
  scope,
  needle,
  onEdit,
  onDelete,
}: {
  bots: Bot[];
  shared: UseQueryResult<Memory[]>;
  perBot: UseQueryResult<Memory[]>[];
  scope: string;
  needle: string;
  onEdit: (memory: Memory, owner: string) => void;
  onDelete: (memory: Memory) => void;
}) {
  const matches = (memories: Memory[]) =>
    needle
      ? memories.filter((memory) =>
          memory.content.toLowerCase().includes(needle),
        )
      : memories;

  const users = bots.flatMap((bot) => (bot.sharedMemory ? [bot.name] : []));

  return (
    <>
      {inScope(scope, SHARED) && (
        <MemorySection
          title={`Shared · ${shared.data?.length ?? 0}`}
          footer={
            users.length
              ? `Used by: ${users.join(", ")}`
              : "No bots use shared memory. Turn it on in a bot's profile."
          }
          memories={matches(shared.data ?? [])}
          total={shared.data?.length ?? 0}
          error={shared.error?.message}
          onEdit={(memory) => onEdit(memory, SHARED)}
          onDelete={onDelete}
        />
      )}
      {bots.map((bot, index) =>
        inScope(scope, bot.id) ? (
          <MemorySection
            key={bot.id}
            title={`${bot.name} · ${perBot[index]?.data?.length ?? 0}`}
            icon={<BotAvatar bot={bot} size={22} />}
            memories={matches(perBot[index]?.data ?? [])}
            total={perBot[index]?.data?.length ?? 0}
            error={perBot[index]?.error?.message}
            onEdit={(memory) => onEdit(memory, bot.id)}
            onDelete={onDelete}
          />
        ) : null,
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

  const refreshing =
    bots.isFetching || shared.isFetching || perBot.some((q) => q.isFetching);

  return { bots, shared, perBot, refreshing };
}

function useDeleteMemory() {
  return useMutation({
    mutationFn: (memory: Memory) =>
      send(memoryPath(memory.agentId ?? SHARED, memory.id), "DELETE"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["memories"] }),
  });
}

export function MemoryPage() {
  const { bots, shared, perBot, refreshing } = useMemoryData();
  const [scope, setScope] = useState(ALL);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);

  const scopeItems = [
    { label: "All", value: ALL },
    { label: "Shared", value: SHARED },
    ...(bots.data ?? []).map((bot) => ({ label: bot.name, value: bot.id })),
  ];

  const remove = useDeleteMemory();

  return (
    <WorkspacePage
      title="Memory"
      refreshing={refreshing}
      onRefresh={() =>
        void queryClient.invalidateQueries({ queryKey: ["memories"] })
      }
      newLabel="New memory"
      onNew={() =>
        setEditing({
          memory: null,
          owner: scope === ALL ? SHARED : scope,
        })
      }
    >
      <MemoryFilters
        scopeItems={scopeItems}
        scope={scope}
        search={search}
        onScope={setScope}
        onSearch={setSearch}
      />
      {remove.isError && (
        <Alert variant="destructive">
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
      {bots.isPending || shared.isPending ? (
        <Skeleton className="h-40" />
      ) : (
        <MemorySections
          bots={bots.data ?? []}
          shared={shared}
          perBot={perBot}
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

function MemorySection({
  title,
  icon,
  footer,
  memories,
  total,
  error,
  onEdit,
  onDelete,
}: {
  title: string;
  icon?: ReactNode;
  footer?: string;
  memories: Memory[];
  total: number;
  error?: string | undefined;
  onEdit: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}) {
  return (
    <Section title={title} icon={icon} footer={footer}>
      {error && <SectionEmpty>{error}</SectionEmpty>}
      {memories.length === 0 && !error && (
        <SectionEmpty>
          {total ? "No memories match your search." : "No memories yet."}
        </SectionEmpty>
      )}
      {memories.map((memory) => (
        <div key={memory.id} className="flex items-start gap-2 p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-sm whitespace-pre-wrap">{memory.content}</p>
            {sourceLabel(memory) && (
              <span className="text-xs text-muted-foreground">
                {sourceLabel(memory)}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Edit"
            onClick={() => onEdit(memory)}
          >
            <HugeiconsIcon icon={PencilEdit01Icon} />
          </Button>
          <ConfirmDelete
            title="Delete this memory?"
            description="The bot forgets it. This cannot be undone."
            onConfirm={() => onDelete(memory)}
            trigger={
              <Button variant="ghost" size="icon-sm" title="Delete">
                <HugeiconsIcon icon={Delete02Icon} />
              </Button>
            }
          />
        </div>
      ))}
    </Section>
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing.memory ? "Edit Memory" : "New Memory"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();

            if (content.trim()) save.mutate();
          }}
        >
          <FieldGroup>
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
            <SaveDialogFooter
              error={save.isError ? save.error : null}
              onCancel={onClose}
              disabled={!content.trim() || save.isPending}
              label={editing.memory ? "Save" : "Add"}
            />
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

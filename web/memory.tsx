import { useState } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { PencilIcon, SearchIcon, TrashIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
} from "./api";
import {
  ConfirmDelete,
  Section,
  SectionEmpty,
  WorkspacePage,
} from "./workspace";

const SHARED = "shared";
const ALL = "all";

type Editing = { memory: Memory | null; owner: string };

function memoryPath(owner: string, id?: string) {
  const base =
    owner === SHARED ? "/v1/memories" : `${agentPath(owner)}/memories`;

  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

export function sourceLabel(memory: Memory) {
  const source = memory.source;

  switch (source?.kind) {
    case "chat":
      return "From the bot chat";
    case "owner":
      return "Added by you";
    case "task":
      return `From the task ${source.name ?? ""}`.trim();
    case "bot":
      return `From a request by ${source.name ?? "a bot"}`;
    case "group":
      return `From the group chat ${source.name ?? ""}`.trim();
    default:
      return null;
  }
}

export function MemoryPage() {
  const bots = useQuery(botsQuery);
  const shared = useQuery(sharedMemoriesQuery);
  const [scope, setScope] = useState(ALL);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);

  const perBot = useQueries({
    queries: (bots.data ?? []).map((bot) => botMemoriesQuery(bot.id)),
  });

  const refreshing =
    bots.isFetching || shared.isFetching || perBot.some((q) => q.isFetching);

  const needle = search.trim().toLowerCase();

  const matches = (memories: Memory[]) =>
    needle
      ? memories.filter((memory) =>
          memory.content.toLowerCase().includes(needle),
        )
      : memories;

  const users = (bots.data ?? []).flatMap((bot) =>
    bot.sharedMemory ? [bot.name] : [],
  );

  const scopeItems = [
    { label: "All", value: ALL },
    { label: "Shared", value: SHARED },
    ...(bots.data ?? []).map((bot) => ({ label: bot.name, value: bot.id })),
  ];

  const remove = useMutation({
    mutationFn: (memory: Memory) =>
      send(memoryPath(memory.agentId ?? SHARED, memory.id), "DELETE"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["memories"] }),
  });

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
      <div className="flex gap-2">
        <Select
          items={scopeItems}
          value={scope}
          onValueChange={(value) => setScope(value ?? ALL)}
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
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search memories"
            placeholder="Search"
            className="pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      {remove.isError && (
        <Alert variant="destructive">
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
      {bots.isPending || shared.isPending ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          {(scope === ALL || scope === SHARED) && (
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
              onEdit={(memory) => setEditing({ memory, owner: SHARED })}
              onDelete={(memory) => remove.mutate(memory)}
            />
          )}
          {(bots.data ?? []).map((bot, index) =>
            scope === ALL || scope === bot.id ? (
              <MemorySection
                key={bot.id}
                title={`${bot.name} · ${perBot[index]?.data?.length ?? 0}`}
                memories={matches(perBot[index]?.data ?? [])}
                total={perBot[index]?.data?.length ?? 0}
                error={perBot[index]?.error?.message}
                onEdit={(memory) => setEditing({ memory, owner: bot.id })}
                onDelete={(memory) => remove.mutate(memory)}
              />
            ) : null,
          )}
        </>
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
  footer,
  memories,
  total,
  error,
  onEdit,
  onDelete,
}: {
  title: string;
  footer?: string;
  memories: Memory[];
  total: number;
  error?: string;
  onEdit: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}) {
  return (
    <Section title={title} footer={footer}>
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
            <PencilIcon />
          </Button>
          <ConfirmDelete
            title="Delete this memory?"
            description="The bot forgets it. This cannot be undone."
            onConfirm={() => onDelete(memory)}
            trigger={
              <Button variant="ghost" size="icon-sm" title="Delete">
                <TrashIcon />
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
            <Field>
              <FieldLabel>Remembered by</FieldLabel>
              <Select
                items={owners}
                value={owner}
                disabled={editing.memory !== null}
                onValueChange={(value) => setOwner(value ?? SHARED)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {owners.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
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
            {save.isError && (
              <Alert variant="destructive">
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!content.trim() || save.isPending}
              >
                {editing.memory ? "Save" : "Add"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

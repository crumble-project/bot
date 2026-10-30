import { type ReactNode, useState } from "react";
import {
  type UseQueryOptions,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { IconBell, IconPencil, IconTrash, IconX } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { OwnerSelectField } from "@/components/form-fields";
import {
  ConfirmDeleteContent,
  FilterPills,
  RowMenu,
  Section,
  SectionEmpty,
} from "@/components/workspace";
import { type Bot, api, botsQuery, send } from "@/lib/api";
import { BotAvatar } from "@/features/bots/avatar";

/** The scope that shows every bot. */
export const ALL = "all";

const USES_PAGE = 50;

/** What a sheet or dialog acts on: an item of one bot. */
export type Target<T> = { botId: string; item: T };

type Named = { name: string; hosts: string[] };

/** A bot's request for a secret, waiting for the owner. */
type Request = Named & { reason: string };

/** One bot with its query for the secrets it holds. */
export type BotEntry<D> = { bot: Bot; query: UseQueryResult<D> };

/** Hosts as the owner types them: separated by commas, spaces, or lines. */
export const hostList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const relative = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
  style: "short",
});

/** "2 hours ago", "yesterday": how long ago something was last used. */
export function ago(iso: string) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);

  if (minutes > -60) return relative.format(minutes, "minute");

  if (minutes > -24 * 60)
    return relative.format(Math.round(minutes / 60), "hour");

  return relative.format(Math.round(minutes / (24 * 60)), "day");
}

export const matches = (item: Named, needle: string) =>
  !needle ||
  item.name.toLowerCase().includes(needle) ||
  item.hosts.some((host) => host.includes(needle));

/** Every bot, each with its own query from `queryOf`. */
export function useBotQueries<D>(
  queryOf: (botId: string) => UseQueryOptions<D, Error, D, string[]>,
) {
  const bots = useQuery(botsQuery);

  const queries = useQueries({
    queries: (bots.data ?? []).map((bot) => queryOf(bot.id)),
  });

  const entries = (bots.data ?? []).flatMap((bot, index) => {
    const query = queries[index];

    return query ? [{ bot, query }] : [];
  });

  const refreshing = bots.isFetching || queries.some((q) => q.isFetching);

  return { bots, entries, refreshing };
}

/** The bots in scope, and those whose frame shows: the one picked, or one with matching items. */
function scopedEntries<D>(
  entries: BotEntry<D>[],
  scope: string,
  needle: string,
  itemsOf: (data: D) => Named[],
) {
  const inScope = entries.filter(
    (entry) => scope === ALL || entry.bot.id === scope,
  );

  const shown = inScope.filter(
    (entry) =>
      scope !== ALL ||
      entry.query.isError ||
      (entry.query.data ? itemsOf(entry.query.data) : []).some((item) =>
        matches(item, needle),
      ),
  );

  return { inScope, shown };
}

export function BotPills<D>({
  label,
  entries,
  scope,
  onScope,
  countOf,
}: {
  label: string;
  entries: BotEntry<D>[];
  scope: string;
  onScope: (scope: string) => void;
  countOf: (entry: BotEntry<D>) => number;
}) {
  return (
    <FilterPills
      label={label}
      value={scope}
      onChange={onScope}
      pills={[
        {
          value: ALL,
          label: "All",
          count: entries.reduce((sum, entry) => sum + countOf(entry), 0),
        },
        ...entries.map((entry) => ({
          value: entry.bot.id,
          label: entry.bot.name,
          icon: <BotAvatar bot={entry.bot} size={18} />,
          count: countOf(entry),
        })),
      ]}
    />
  );
}

function RequestRow({
  bot,
  request,
  onAdd,
  onDecline,
}: {
  bot: Bot;
  request: Request;
  onAdd: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <BotAvatar bot={bot} size={24} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">
          <span className="font-medium">{bot.name}</span>{" "}
          <span className="text-muted-foreground">asks for</span>{" "}
          <span className="font-mono font-medium">{request.name}</span>
        </span>
        <span
          className="truncate text-xs text-muted-foreground"
          title={request.reason}
        >
          {request.reason} · {request.hosts.join(", ")}
        </span>
      </div>
      <Button size="sm" onClick={onAdd}>
        Add
      </Button>
      <RowMenu>
        <DropdownMenuItem variant="destructive" onClick={onDecline}>
          <IconX />
          Decline
        </DropdownMenuItem>
      </RowMenu>
    </div>
  );
}

/** The bots' requests in scope that match the search, under "Waiting for you". */
function WaitingRequests<D, R extends Request>({
  entries,
  needle,
  requestsOf,
  onAdd,
  onDecline,
}: {
  entries: BotEntry<D>[];
  needle: string;
  requestsOf: (data: D) => R[];
  onAdd: (botId: string, request: R) => void;
  onDecline: (botId: string, name: string) => void;
}) {
  const requests = entries.flatMap(({ bot, query }) =>
    (query.data ? requestsOf(query.data) : []).flatMap((request) =>
      matches(request, needle) ? [{ bot, request }] : [],
    ),
  );

  if (!requests.length) return null;

  return (
    <Section title="Waiting for you" icon={<IconBell className="size-4" />}>
      {requests.map(({ bot, request }) => (
        <RequestRow
          key={`${bot.id}:${request.name}`}
          bot={bot}
          request={request}
          onAdd={() => onAdd(bot.id, request)}
          onDecline={() => onDecline(bot.id, request.name)}
        />
      ))}
    </Section>
  );
}

/** One bot's frame: its error, an empty or no-match note, or its rows. */
function BotSecretSection<D>({
  entry,
  total,
  shown,
  empty,
  noMatch,
  children,
}: {
  entry: BotEntry<D>;
  total: number;
  shown: number;
  empty: string;
  noMatch: string;
  children: ReactNode;
}) {
  const { bot, query } = entry;

  return (
    <Section title={bot.name} icon={<BotAvatar bot={bot} size={22} />}>
      {query.isError && <SectionEmpty>{query.error.message}</SectionEmpty>}
      {query.isSuccess && shown === 0 && (
        <SectionEmpty>{total ? noMatch : empty}</SectionEmpty>
      )}
      {children}
    </Section>
  );
}

/** A row's name and hosts, which open its editor. */
export function SecretRowName({
  name,
  hosts,
  mono,
  onEdit,
}: {
  name: string;
  hosts: string[];
  mono?: boolean;
  onEdit: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={onEdit}
    >
      <span
        className={`shrink-0 text-sm font-medium${mono ? " font-mono" : ""}`}
      >
        {name}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {hosts.join(", ")}
      </span>
    </button>
  );
}

/** The newest use's error, else when it was last used. */
export function LastUse({
  lastUsedAt,
  lastError,
  used,
  never,
}: {
  lastUsedAt: string | null;
  lastError: string | null;
  /** The verb before the time, such as "Used". */
  used: string;
  never: string;
}) {
  if (lastError)
    return (
      <span
        className="hidden max-w-64 shrink truncate text-xs text-destructive sm:block"
        title={lastError}
      >
        {lastError}
      </span>
    );

  return (
    <span
      className="hidden shrink-0 text-xs text-muted-foreground sm:block"
      title={lastUsedAt ? when(lastUsedAt) : undefined}
    >
      {lastUsedAt ? `${used} ${ago(lastUsedAt)}` : never}
    </span>
  );
}

export function SecretRowMenu({
  uses,
  onUses,
  onEdit,
  onDelete,
}: {
  /** The history item's label, with its icon. */
  uses: ReactNode;
  onUses: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <RowMenu>
      <DropdownMenuItem onClick={onUses}>{uses}</DropdownMenuItem>
      <DropdownMenuItem onClick={onEdit}>
        <IconPencil />
        Edit
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <IconTrash />
        Delete
      </DropdownMenuItem>
    </RowMenu>
  );
}

/** The bot a new item is for, asked only when it isn't already known. */
export function OwnerField({
  bots,
  botId,
  owner,
  onOwner,
}: {
  bots: Bot[];
  botId: string | null;
  owner: string;
  onOwner: (owner: string) => void;
}) {
  if (botId !== null) return null;

  return (
    <OwnerSelectField
      label="For bot"
      owners={bots.map((bot) => ({ label: bot.name, value: bot.id }))}
      value={owner}
      disabled={false}
      onValueChange={(next) => next && onOwner(next)}
    />
  );
}

/** An item's uses, newest first, paged by the last use's ID. */
export function UsesDialog<U extends { id: string; at: string }>({
  title,
  description,
  empty,
  queryKey,
  path,
  children,
  onClose,
}: {
  title: string;
  description: string;
  empty: string;
  queryKey: readonly unknown[];
  /** The uses endpoint, without its query. */
  path: string;
  children: (use: U) => ReactNode;
  onClose: () => void;
}) {
  const uses = useInfiniteQuery({
    queryKey,
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api<U[]>(
        `${path}?limit=${USES_PAGE}${pageParam && `&before=${encodeURIComponent(pageParam)}`}`,
        { signal },
      ),
    getNextPageParam: (page) =>
      page.length === USES_PAGE ? page.at(-1)?.id : undefined,
  });

  const rows = uses.data?.pages.flat() ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {uses.isPending ? (
          <Skeleton className="h-32" />
        ) : uses.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{uses.error.message}</AlertDescription>
          </Alert>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="flex flex-col divide-y rounded-lg border text-sm">
            {rows.map((use) => (
              <div key={use.id} className="flex items-baseline gap-3 p-2">
                <span className="w-36 shrink-0 text-xs text-muted-foreground">
                  {when(use.at)}
                </span>
                {children(use)}
              </div>
            ))}
          </div>
        )}
        {uses.hasNextPage && (
          <Button
            variant="outline"
            disabled={uses.isFetchingNextPage}
            onClick={() => uses.fetchNextPage()}
          >
            Load More
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The bots' requests, then each bot's frame of items matching the search, then a note. */
export function SecretGroups<D, I extends Named, R extends Request>({
  entries,
  scope,
  needle,
  itemsOf,
  requestsOf,
  onAdd,
  onDecline,
  empty,
  noMatch,
  note,
  children,
}: {
  entries: BotEntry<D>[];
  scope: string;
  needle: string;
  itemsOf: (data: D) => I[];
  requestsOf: (data: D) => R[];
  onAdd: (botId: string, request: R) => void;
  onDecline: (botId: string, name: string) => void;
  empty: string;
  noMatch: string;
  note: ReactNode;
  /** One item's row. */
  children: (botId: string, item: I) => ReactNode;
}) {
  const { inScope, shown } = scopedEntries(entries, scope, needle, itemsOf);

  return (
    <>
      <WaitingRequests
        entries={inScope}
        needle={needle}
        requestsOf={requestsOf}
        onAdd={onAdd}
        onDecline={onDecline}
      />
      {shown.map((entry) => {
        const all = entry.query.data ? itemsOf(entry.query.data) : [];
        const matching = all.filter((item) => matches(item, needle));

        return (
          <BotSecretSection
            key={entry.bot.id}
            entry={entry}
            total={all.length}
            shown={matching.length}
            empty={empty}
            noMatch={noMatch}
          >
            {matching.map((item) => children(entry.bot.id, item))}
          </BotSecretSection>
        );
      })}
      <p className="text-xs text-muted-foreground">{note}</p>
    </>
  );
}

/** Which item's uses are open and which is being deleted, and declining a bot's request. */
export function useSecretActions<I>(
  pathOf: (botId: string, name: string) => string,
  invalidate: (botId: string) => Promise<void>,
) {
  const [uses, setUses] = useState<Target<I> | null>(null);
  const [deleting, setDeleting] = useState<Target<string> | null>(null);

  const remove = useMutation({
    mutationFn: ({ botId, item }: Target<string>) =>
      send(pathOf(botId, item), "DELETE"),
    onSettled: (_result, _error, { botId }) => invalidate(botId),
  });

  // Never DELETE: a saved item and a request for more under its name can coexist.
  const decline = useMutation({
    mutationFn: ({ botId, item }: Target<string>) =>
      send(`${pathOf(botId, item)}/decline`, "POST"),
    onSettled: (_result, _error, { botId }) => invalidate(botId),
  });

  return { uses, setUses, deleting, setDeleting, remove, decline };
}

export function DeleteSecretDialog({
  actions,
  description,
}: {
  actions: Pick<
    ReturnType<typeof useSecretActions>,
    "deleting" | "setDeleting" | "remove"
  >;
  description: string;
}) {
  const { deleting, remove } = actions;

  return (
    <AlertDialog
      open={deleting !== null}
      onOpenChange={(open) => !open && actions.setDeleting(null)}
    >
      <ConfirmDeleteContent
        title={`Delete ${deleting?.item ?? ""}?`}
        description={description}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </AlertDialog>
  );
}

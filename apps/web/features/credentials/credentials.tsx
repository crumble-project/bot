import { useState } from "react";
import {
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import {
  IconBell,
  IconHistory,
  IconPencil,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { EditorSheet, OwnerSelectField } from "@/components/form-fields";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type Bot,
  type Credential,
  type CredentialRequest,
  type Credentials,
  type CredentialUse,
  api,
  botsQuery,
  call,
  credentialPath,
  credentialsQuery,
  queryClient,
  send,
} from "@/lib/api";
import {
  ConfirmDeleteContent,
  FilterPills,
  NewButton,
  PageToolbar,
  RowMenu,
  Section,
  SectionEmpty,
  WorkspacePage,
} from "@/components/workspace";
import { BotAvatar } from "@/features/bots/avatar";

const USES_PAGE = 50;

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Hosts as the owner types them: separated by commas, spaces, or lines. */
const hostList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

/** What the dialog edits: a credential, a request to answer, or a new credential. */
type Editing =
  | { kind: "credential"; credential: Credential }
  | { kind: "request"; request: CredentialRequest }
  | { kind: "new" };

/** "2 hours ago", "yesterday": how long ago a credential was last used. */
function ago(iso: string) {
  const relative = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
    style: "short",
  });

  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);

  if (minutes > -60) return relative.format(minutes, "minute");

  if (minutes > -24 * 60)
    return relative.format(Math.round(minutes / 60), "hour");

  return relative.format(Math.round(minutes / (24 * 60)), "day");
}

const ALL = "all";

/** What a sheet or dialog acts on: a credential or request of one bot. */
type Target<T> = { botId: string; item: T };

type BotCredentials = {
  bot: Bot;
  credentials: UseQueryResult<Credentials>;
};

const invalidate = (botId: string) =>
  queryClient.invalidateQueries({ queryKey: credentialsQuery(botId).queryKey });

const matches = (item: { name: string; hosts: string[] }, needle: string) =>
  !needle ||
  item.name.toLowerCase().includes(needle) ||
  item.hosts.some((host) => host.includes(needle));

const countOf = (entry: BotCredentials) =>
  (entry.credentials.data?.credentials.length ?? 0) +
  (entry.credentials.data?.requests.length ?? 0);

function useBotCredentials() {
  const bots = useQuery(botsQuery);

  const queries = useQueries({
    queries: (bots.data ?? []).map((bot) => credentialsQuery(bot.id)),
  });

  const entries = (bots.data ?? []).flatMap((bot, index) => {
    const credentials = queries[index];

    return credentials ? [{ bot, credentials }] : [];
  });

  const refreshing = bots.isFetching || queries.some((q) => q.isFetching);

  return { bots, entries, refreshing };
}

function CredentialPills({
  entries,
  scope,
  onScope,
}: {
  entries: BotCredentials[];
  scope: string;
  onScope: (scope: string) => void;
}) {
  return (
    <FilterPills
      label="Whose credentials"
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
  request: CredentialRequest;
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

function CredentialRow({
  credential,
  onEdit,
  onUses,
  onDelete,
}: {
  credential: Credential;
  onEdit: () => void;
  onUses: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/50">
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onEdit}
      >
        <span className="shrink-0 font-mono text-sm font-medium">
          {credential.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {credential.hosts.join(", ")}
        </span>
      </button>
      <span
        className="hidden shrink-0 text-xs text-muted-foreground sm:block"
        title={credential.lastUsedAt ? when(credential.lastUsedAt) : undefined}
      >
        {credential.lastUsedAt
          ? `Used ${ago(credential.lastUsedAt)}`
          : "Never used"}
      </span>
      <RowMenu>
        <DropdownMenuItem onClick={onUses}>
          <IconHistory />
          Uses
        </DropdownMenuItem>
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
    </div>
  );
}

type Handlers = {
  onAdd: (botId: string, request: CredentialRequest) => void;
  onDecline: (botId: string, name: string) => void;
  onEdit: (botId: string, credential: Credential) => void;
  onUses: (botId: string, credential: Credential) => void;
  onDelete: (botId: string, name: string) => void;
};

function Requests({
  entries,
  needle,
  handlers,
}: {
  entries: BotCredentials[];
  needle: string;
  handlers: Handlers;
}) {
  const requests = entries.flatMap(({ bot, credentials }) =>
    (credentials.data?.requests ?? []).flatMap((request) =>
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
          onAdd={() => handlers.onAdd(bot.id, request)}
          onDecline={() => handlers.onDecline(bot.id, request.name)}
        />
      ))}
    </Section>
  );
}

function BotSection({
  entry,
  needle,
  handlers,
}: {
  entry: BotCredentials;
  needle: string;
  handlers: Handlers;
}) {
  const { bot, credentials } = entry;
  const all = credentials.data?.credentials ?? [];
  const shown = all.filter((credential) => matches(credential, needle));

  return (
    <Section title={bot.name} icon={<BotAvatar bot={bot} size={22} />}>
      {credentials.isError && (
        <SectionEmpty>{credentials.error.message}</SectionEmpty>
      )}
      {credentials.isSuccess && shown.length === 0 && (
        <SectionEmpty>
          {all.length
            ? "No credentials match your search."
            : "None yet. The bot asks for one when a coding job needs it."}
        </SectionEmpty>
      )}
      {shown.map((credential) => (
        <CredentialRow
          key={credential.name}
          credential={credential}
          onEdit={() => handlers.onEdit(bot.id, credential)}
          onUses={() => handlers.onUses(bot.id, credential)}
          onDelete={() => handlers.onDelete(bot.id, credential.name)}
        />
      ))}
    </Section>
  );
}

/** Whether a bot earns its frame: the one picked, or one with matching credentials. */
function sectionShown(entry: BotCredentials, scope: string, needle: string) {
  if (scope !== ALL) return scope === entry.bot.id;

  if (entry.credentials.isError) return true;

  return (entry.credentials.data?.credentials ?? []).some((credential) =>
    matches(credential, needle),
  );
}

function CredentialGroups({
  entries,
  scope,
  needle,
  handlers,
}: {
  entries: BotCredentials[];
  scope: string;
  needle: string;
  handlers: Handlers;
}) {
  const inScope = entries.filter(
    (entry) => scope === ALL || entry.bot.id === scope,
  );

  const shown = inScope.filter((entry) => sectionShown(entry, scope, needle));

  return (
    <>
      <Requests entries={inScope} needle={needle} handlers={handlers} />
      {shown.map((entry) => (
        <BotSection
          key={entry.bot.id}
          entry={entry}
          needle={needle}
          handlers={handlers}
        />
      ))}
      <p className="text-xs text-muted-foreground">
        Coding jobs get a placeholder for each credential; the value only goes
        to its hosts. Uses are kept for 90 days.
      </p>
    </>
  );
}

function useCredentialActions() {
  const [editing, setEditing] = useState<{
    botId: string | null;
    editing: Editing;
  } | null>(null);

  const [uses, setUses] = useState<Target<Credential> | null>(null);
  const [deleting, setDeleting] = useState<Target<string> | null>(null);

  // Deleting a request declines it; the bot hears either way.
  const remove = useMutation({
    mutationFn: ({ botId, item }: Target<string>) =>
      send(credentialPath(botId, item), "DELETE"),
    onSettled: (_result, _error, { botId }) => invalidate(botId),
  });

  const handlers: Handlers = {
    onAdd: (botId, request) =>
      setEditing({ botId, editing: { kind: "request", request } }),
    onDecline: (botId, name) => remove.mutate({ botId, item: name }),
    onEdit: (botId, credential) =>
      setEditing({ botId, editing: { kind: "credential", credential } }),
    onUses: (botId, credential) => setUses({ botId, item: credential }),
    onDelete: (botId, name) => setDeleting({ botId, item: name }),
  };

  return {
    editing,
    setEditing,
    uses,
    setUses,
    deleting,
    setDeleting,
    remove,
    handlers,
  };
}

/** Every bot's credentials and requests, with values the owner enters but never sees again. */
export function CredentialsSettings({
  initialBot,
}: {
  initialBot?: string | undefined;
}) {
  const { bots, entries, refreshing } = useBotCredentials();
  const [scope, setScope] = useState(initialBot ?? ALL);
  const [search, setSearch] = useState("");
  const actions = useCredentialActions();
  const { editing, uses, remove } = actions;
  const needle = search.trim().toLowerCase();

  return (
    <WorkspacePage
      title="Credentials"
      refreshing={refreshing}
      onRefresh={() =>
        void Promise.all(entries.map((entry) => invalidate(entry.bot.id)))
      }
    >
      <div className="flex flex-col gap-3">
        <PageToolbar
          search={search}
          searchLabel="Search credentials"
          onSearch={setSearch}
        >
          <NewButton
            label="New credential"
            disabled={!bots.data?.length}
            onClick={() =>
              actions.setEditing({
                botId: scope === ALL ? null : scope,
                editing: { kind: "new" },
              })
            }
          />
        </PageToolbar>
        <CredentialPills entries={entries} scope={scope} onScope={setScope} />
      </div>
      {remove.isError && (
        <Alert variant="destructive">
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
      {bots.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <CredentialGroups
          entries={entries}
          scope={scope}
          needle={needle}
          handlers={actions.handlers}
        />
      )}
      {editing && (
        <CredentialDialog
          bots={bots.data ?? []}
          botId={editing.botId}
          editing={editing.editing}
          onClose={() => actions.setEditing(null)}
        />
      )}
      {uses && (
        <UsesDialog
          botId={uses.botId}
          credential={uses.item}
          onClose={() => actions.setUses(null)}
        />
      )}
      <DeleteCredentialDialog actions={actions} />
    </WorkspacePage>
  );
}

function DeleteCredentialDialog({
  actions,
}: {
  actions: ReturnType<typeof useCredentialActions>;
}) {
  const { deleting, remove } = actions;

  return (
    <AlertDialog
      open={deleting !== null}
      onOpenChange={(open) => !open && actions.setDeleting(null)}
    >
      <ConfirmDeleteContent
        title={`Delete ${deleting?.item ?? ""}?`}
        description="Requests with its placeholder stop working at once, and its uses are deleted. This cannot be undone."
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </AlertDialog>
  );
}

function useSaveCredential(
  botId: string,
  draft: { name: string; hosts: string; value: string },
  onClose: () => void,
) {
  return useMutation({
    mutationFn: () =>
      call<Credential, { hosts: string[]; value?: string }>(
        credentialPath(botId, draft.name),
        "PUT",
        {
          hosts: hostList(draft.hosts),
          ...(draft.value && { value: draft.value }),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: credentialsQuery(botId).queryKey,
      });
      onClose();
    },
  });
}

function credentialDraft(editing: Editing) {
  const existing = editing.kind === "credential" ? editing.credential : null;
  const request = editing.kind === "request" ? editing.request : null;
  const source = existing ?? request;

  return {
    existing,
    request,
    name: source?.name ?? "",
    hosts: (source?.hosts ?? []).join(", "),
  };
}

function credentialReady(
  name: string,
  hosts: string,
  value: string,
  existing: Credential | null,
  pending: boolean,
) {
  return (
    NAME.test(name) &&
    hostList(hosts).length > 0 &&
    (existing !== null || value !== "") &&
    !pending
  );
}

function CredentialDialog({
  bots,
  botId,
  editing,
  onClose,
}: {
  bots: Bot[];
  /** Null for a new credential from all bots: the sheet asks which bot it is for. */
  botId: string | null;
  editing: Editing;
  onClose: () => void;
}) {
  const { existing, request, ...initial } = credentialDraft(editing);
  const [owner, setOwner] = useState(botId ?? bots[0]?.id ?? "");
  const [name, setName] = useState(initial.name);
  const [hosts, setHosts] = useState(initial.hosts);
  const [value, setValue] = useState("");

  const save = useSaveCredential(owner, { name, hosts, value }, onClose);

  const ready = credentialReady(name, hosts, value, existing, save.isPending);

  return (
    <EditorSheet
      title={existing ? `Edit ${existing.name}` : "New Credential"}
      description={request?.reason}
      error={save.error?.message}
      submitLabel={existing ? "Save" : "Add"}
      submitDisabled={!ready}
      onSubmit={() => ready && save.mutate()}
      onClose={onClose}
    >
      {botId === null && (
        <OwnerSelectField
          label="For bot"
          owners={bots.map((bot) => ({ label: bot.name, value: bot.id }))}
          value={owner}
          disabled={false}
          onValueChange={(next) => next && setOwner(next)}
        />
      )}
      <CredentialFields
        locked={editing.kind !== "new"}
        proposed={request !== null}
        replacing={existing !== null}
        draft={{ name, hosts, value }}
        onName={setName}
        onHosts={setHosts}
        onValue={setValue}
      />
    </EditorSheet>
  );
}

function CredentialFields({
  locked,
  proposed,
  replacing,
  draft,
  onName,
  onHosts,
  onValue,
}: {
  locked: boolean;
  proposed: boolean;
  replacing: boolean;
  draft: { name: string; hosts: string; value: string };
  onName: (name: string) => void;
  onHosts: (hosts: string) => void;
  onValue: (value: string) => void;
}) {
  const nameInvalid = draft.name !== "" && !NAME.test(draft.name);

  return (
    <>
      <Field data-invalid={nameInvalid || undefined}>
        <FieldLabel htmlFor="credential-name">Name</FieldLabel>
        <Input
          id="credential-name"
          placeholder="ACME_TOKEN"
          autoComplete="off"
          disabled={locked}
          aria-invalid={nameInvalid || undefined}
          value={draft.name}
          onChange={(event) => onName(event.target.value.toUpperCase())}
        />
        <FieldDescription>
          The environment variable coding jobs see.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="credential-hosts">Hosts</FieldLabel>
        <Input
          id="credential-hosts"
          placeholder="api.example.com, *.example.com"
          autoComplete="off"
          value={draft.hosts}
          onChange={(event) => onHosts(event.target.value)}
        />
        <FieldDescription>
          {proposed
            ? "The bot proposed these. The value goes only to them, so check they belong to the service."
            : "The value goes only to these hosts. *.example.com covers every subdomain."}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="credential-value">Value</FieldLabel>
        <Input
          id="credential-value"
          type="password"
          autoComplete="off"
          placeholder={replacing ? "Keep the saved value" : undefined}
          value={draft.value}
          onChange={(event) => onValue(event.target.value)}
        />
        <FieldDescription>
          Stored encrypted and never shown again.
        </FieldDescription>
      </Field>
    </>
  );
}

function UsesDialog({
  botId,
  credential,
  onClose,
}: {
  botId: string;
  credential: Credential;
  onClose: () => void;
}) {
  const uses = useInfiniteQuery({
    queryKey: ["credential-uses", botId, credential.name],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api<CredentialUse[]>(
        `${credentialPath(botId, credential.name)}/uses?limit=${USES_PAGE}${pageParam && `&before=${encodeURIComponent(pageParam)}`}`,
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
          <DialogTitle>Uses of {credential.name}</DialogTitle>
          <DialogDescription>
            Requests sent with the value in the last 90 days, newest first.
          </DialogDescription>
        </DialogHeader>
        {uses.isPending ? (
          <Skeleton className="h-32" />
        ) : uses.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{uses.error.message}</AlertDescription>
          </Alert>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not used yet.</p>
        ) : (
          <div className="flex flex-col divide-y rounded-lg border text-sm">
            {rows.map((use) => (
              <div key={use.id} className="flex items-baseline gap-3 p-2">
                <span className="w-36 shrink-0 text-xs text-muted-foreground">
                  {when(use.at)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {use.method} {use.host}
                  {use.path}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {use.status ?? "failed"}
                </span>
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

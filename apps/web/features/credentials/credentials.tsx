import { type ReactNode, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { IconDots } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type Credential,
  type CredentialRequest,
  type CredentialUse,
  api,
  botsQuery,
  call,
  credentialPath,
  credentialsQuery,
  queryClient,
  send,
} from "@/lib/api";
import { WorkspacePage } from "@/components/workspace";

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

/** A bot's credentials and its requests for them, with values the owner enters but never sees again. */
export function CredentialsPage({ botId }: { botId: string }) {
  const bots = useQuery(botsQuery);
  const credentials = useQuery(credentialsQuery(botId));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [uses, setUses] = useState<Credential | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const bot = bots.data?.find((item) => item.id === botId);

  // Deleting a request declines it; the bot hears either way.
  const remove = useMutation({
    mutationFn: (name: string) => send(credentialPath(botId, name), "DELETE"),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: credentialsQuery(botId).queryKey,
      }),
  });

  const empty =
    credentials.data?.requests.length === 0 &&
    credentials.data.credentials.length === 0;

  return (
    <WorkspacePage
      title={bot ? `${bot.name}: Credentials` : "Credentials"}
      onRefresh={() => credentials.refetch()}
      refreshing={credentials.isFetching}
      onNew={() => setEditing({ kind: "new" })}
      newLabel="New Credential"
    >
      {credentials.isPending ? (
        <Skeleton className="h-40" />
      ) : credentials.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{credentials.error.message}</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">Name</TableHead>
                  <TableHead>Hosts</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="w-0 pr-3">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.data.requests.map((request) => (
                  <TableRow key={`request:${request.name}`}>
                    <TableCell className="max-w-64 pl-3">
                      <div className="font-medium">{request.name}</div>
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={request.reason}
                      >
                        {request.reason}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {request.hosts.join(", ")}
                    </TableCell>
                    <TableCell>
                      <Badge>Requested</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">—</TableCell>
                    <TableCell className="pr-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          onClick={() =>
                            setEditing({ kind: "request", request })
                          }
                        >
                          Add
                        </Button>
                        <RowMenu>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => remove.mutate(request.name)}
                          >
                            Decline
                          </DropdownMenuItem>
                        </RowMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {credentials.data.credentials.map((credential) => (
                  <TableRow key={credential.name}>
                    <TableCell className="pl-3 font-medium">
                      {credential.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {credential.hosts.join(", ")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">Active</Badge>
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground"
                      title={
                        credential.lastUsedAt
                          ? when(credential.lastUsedAt)
                          : undefined
                      }
                    >
                      {credential.lastUsedAt
                        ? ago(credential.lastUsedAt)
                        : "never"}
                    </TableCell>
                    <TableCell className="pr-3">
                      <div className="flex justify-end">
                        <RowMenu>
                          <DropdownMenuItem onClick={() => setUses(credential)}>
                            Uses
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              setEditing({ kind: "credential", credential })
                            }
                          >
                            Edit…
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDeleting(credential.name)}
                          >
                            Delete…
                          </DropdownMenuItem>
                        </RowMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {empty && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-6 text-center text-muted-foreground"
                    >
                      None yet. The bot asks for one when a coding job needs it.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Coding jobs get a placeholder for each credential; the value only
            goes to its hosts. Uses are kept for 90 days.
          </p>
          {remove.isError && (
            <Alert variant="destructive">
              <AlertDescription>{remove.error.message}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
      {editing && (
        <CredentialDialog
          botId={botId}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {uses && (
        <UsesDialog
          botId={botId}
          credential={uses}
          onClose={() => setUses(null)}
        />
      )}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting}?</AlertDialogTitle>
            <AlertDialogDescription>
              Requests with its placeholder stop working at once, and its uses
              are deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleting && remove.mutate(deleting)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkspacePage>
  );
}

function RowMenu({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" title="More">
            <IconDots />
          </Button>
        }
      />
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
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

function CredentialDialog({
  botId,
  editing,
  onClose,
}: {
  botId: string;
  editing: Editing;
  onClose: () => void;
}) {
  const { existing, request, ...initial } = credentialDraft(editing);
  const [name, setName] = useState(initial.name);
  const [hosts, setHosts] = useState(initial.hosts);
  const [value, setValue] = useState("");

  const save = useSaveCredential(botId, { name, hosts, value }, onClose);

  const ready =
    NAME.test(name) &&
    hostList(hosts).length > 0 &&
    (existing !== null || value !== "") &&
    !save.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.name}` : "Add Credential"}
          </DialogTitle>
          {request && <DialogDescription>{request.reason}</DialogDescription>}
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();

            if (ready) save.mutate();
          }}
        >
          <FieldGroup>
            <CredentialFields
              locked={editing.kind !== "new"}
              proposed={request !== null}
              replacing={existing !== null}
              draft={{ name, hosts, value }}
              onName={setName}
              onHosts={setHosts}
              onValue={setValue}
            />
            {save.isError && (
              <Alert variant="destructive">
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!ready}>
                {existing ? "Save" : "Add"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
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

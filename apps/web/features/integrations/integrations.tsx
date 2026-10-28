import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  IconLogout,
  IconPencil,
  IconPlug,
  IconTrash,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { EditorSheet, OwnerSelectField } from "@/components/form-fields";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  type Bot,
  type McpServer,
  botsQuery,
  call,
  mcpServersQuery,
  queryClient,
  send,
} from "@/lib/api";
import {
  ConfirmDeleteContent,
  NewButton,
  PageToolbar,
  RowMenu,
  RowTile,
  Section,
  SectionEmpty,
  WorkspacePage,
} from "@/components/workspace";
import { BotAvatar } from "@/features/bots/avatar";

const SHARED = "shared";
const OAUTH_SERVER_KEY = "crumble.oauth.server";

type OAuthStart = { authorizationUrl: string } | { authorized: true };

const serverPath = (id: string) => `/v1/mcp-servers/${encodeURIComponent(id)}`;

async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: mcpServersQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: botsQuery.queryKey }),
  ]);
}

function authLabel(server: McpServer) {
  if (server.auth === "oauth") return "Signed in";

  return server.auth === "token" ? "Token" : "No sign-in";
}

function validUrl(value: string) {
  try {
    const url = new URL(value);

    return (url.protocol === "http:" || url.protocol === "https:") && url.host;
  } catch {
    return false;
  }
}

type Editing = { server: McpServer | null };

function personalServers(bots: Bot[], list: McpServer[]) {
  return bots.flatMap((bot) => {
    const own = list.filter((server) => server.agentId === bot.id);

    return own.length ? [{ bot, servers: own }] : [];
  });
}

function IntegrationSections({
  shared,
  personal,
  onEdit,
}: {
  shared: McpServer[];
  personal: { bot: Bot; servers: McpServer[] }[];
  onEdit: (server: McpServer) => void;
}) {
  return (
    <>
      <Section
        title="Shared"
        description="Turn a shared server on for any bot in its profile."
      >
        {shared.length === 0 && (
          <SectionEmpty>No shared MCP servers yet.</SectionEmpty>
        )}
        {shared.map((server) => (
          <ServerRow
            key={server.id}
            server={server}
            onEdit={() => onEdit(server)}
          />
        ))}
      </Section>
      {personal.map(({ bot, servers: own }) => (
        <Section
          key={bot.id}
          title={bot.name}
          icon={<BotAvatar bot={bot} size={22} />}
          description={`Only ${bot.name} can use these.`}
        >
          {own.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              onEdit={() => onEdit(server)}
            />
          ))}
        </Section>
      ))}
    </>
  );
}

export function IntegrationsPage() {
  const bots = useQuery(botsQuery);
  const servers = useQuery(mcpServersQuery);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();

  const list = (servers.data ?? []).filter(
    (server) =>
      !needle ||
      server.name.toLowerCase().includes(needle) ||
      server.url.toLowerCase().includes(needle),
  );

  return (
    <WorkspacePage
      title="Integrations"
      refreshing={bots.isFetching || servers.isFetching}
      onRefresh={() => void refresh()}
    >
      <PageToolbar
        search={search}
        searchLabel="Search MCP servers"
        onSearch={setSearch}
      >
        <NewButton
          label="New MCP server"
          onClick={() => setEditing({ server: null })}
        />
      </PageToolbar>
      {servers.isPending || bots.isPending ? (
        <Skeleton className="h-40" />
      ) : servers.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{servers.error.message}</AlertDescription>
        </Alert>
      ) : (
        <IntegrationSections
          shared={list.filter((server) => server.agentId === null)}
          personal={personalServers(bots.data ?? [], list)}
          onEdit={(server) => setEditing({ server })}
        />
      )}
      {editing && (
        <ServerDialog
          bots={bots.data ?? []}
          server={editing.server}
          onClose={() => setEditing(null)}
        />
      )}
    </WorkspacePage>
  );
}

function useServerActions(server: McpServer) {
  const signIn = useMutation({
    mutationFn: async () => {
      const result = await call<OAuthStart, { redirectUri: string }>(
        `${serverPath(server.id)}/oauth`,
        "POST",
        { redirectUri: `${location.origin}/ui/oauth/callback` },
      );

      if ("authorizationUrl" in result) {
        sessionStorage.setItem(OAUTH_SERVER_KEY, server.id);
        location.href = result.authorizationUrl;
      }
    },
    onSettled: refresh,
  });

  const signOut = useMutation({
    mutationFn: () => send(`${serverPath(server.id)}/oauth`, "DELETE"),
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: () => send(serverPath(server.id), "DELETE"),
    onSettled: refresh,
  });

  return { signIn, signOut, remove };
}

function ServerRow({
  server,
  onEdit,
}: {
  server: McpServer;
  onEdit: () => void;
}) {
  const { signIn, signOut, remove } = useServerActions(server);
  const [deleting, setDeleting] = useState(false);

  const failure =
    server.error ?? (signIn.error ?? signOut.error ?? remove.error)?.message;

  return (
    <div className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/50">
      <RowTile>
        <IconPlug />
      </RowTile>
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onEdit}
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">{server.name}</span>
          {!server.enabled && <Badge variant="outline">Disabled</Badge>}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {server.url}
        </span>
        {failure && <span className="text-xs text-destructive">{failure}</span>}
      </button>
      <span className="hidden text-sm text-muted-foreground sm:block">
        {authLabel(server)}
      </span>
      {server.auth !== "oauth" && (
        <Button
          variant="outline"
          size="sm"
          disabled={signIn.isPending}
          onClick={() => signIn.mutate()}
        >
          {signIn.isPending && <Spinner data-icon="inline-start" />}
          Sign in
        </Button>
      )}
      <RowMenu>
        <DropdownMenuItem onClick={onEdit}>
          <IconPencil />
          Edit
        </DropdownMenuItem>
        {server.auth === "oauth" && (
          <DropdownMenuItem
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            <IconLogout />
            Sign out
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => setDeleting(true)}
        >
          <IconTrash />
          Delete
        </DropdownMenuItem>
      </RowMenu>
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <ConfirmDeleteContent
          title={`Delete ${server.name}?`}
          description="Bots lose its tools and its sign-in is removed. This cannot be undone."
          onConfirm={() => remove.mutate()}
        />
      </AlertDialog>
    </div>
  );
}

type ServerDraft = {
  owner: string;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
};

const BLANK_DRAFT: ServerDraft = {
  owner: SHARED,
  name: "",
  url: "",
  token: "",
  enabled: true,
  clientId: "",
  clientSecret: "",
};

function initialDraft(server: McpServer | null): ServerDraft {
  if (!server) return BLANK_DRAFT;

  return {
    ...BLANK_DRAFT,
    owner: server.agentId ?? SHARED,
    name: server.name,
    url: server.url,
    enabled: server.enabled,
    clientId: server.oauthClientId ?? "",
  };
}

function oauthClientPatch(draft: ServerDraft, server: McpServer | null) {
  const clientId = draft.clientId.trim();
  const clientSecret = draft.clientSecret.trim();

  return {
    ...((clientId || server?.oauthClientId) && {
      oauthClientId: clientId || null,
    }),
    // Without an app, its secret has no use; clearing the client ID removes it too.
    ...(clientSecret
      ? { oauthClientSecret: clientSecret }
      : !clientId && server?.hasOAuthClientSecret && { oauthClientSecret: "" }),
  };
}

function serverBody(draft: ServerDraft, server: McpServer | null) {
  const token = draft.token.trim();

  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    enabled: draft.enabled,
    ...(token && { token }),
    ...oauthClientPatch(draft, server),
  };
}

function useSaveServer(
  draft: ServerDraft,
  server: McpServer | null,
  reset: () => void,
  onClose: () => void,
) {
  return useMutation({
    mutationFn: () => {
      const body = serverBody(draft, server);

      return server
        ? send(serverPath(server.id), "PATCH", body)
        : send("/v1/mcp-servers", "POST", {
            ...body,
            agentId: draft.owner === SHARED ? null : draft.owner,
          });
    },
    onSuccess: async () => {
      reset();
      await refresh();
      onClose();
    },
  });
}

function ServerDialog({
  bots,
  server,
  onClose,
}: {
  bots: Bot[];
  server: McpServer | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(server));

  const patch = (change: Partial<ServerDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  const save = useSaveServer(
    draft,
    server,
    () => patch({ token: "", clientSecret: "" }),
    onClose,
  );

  const valid = Boolean(draft.name.trim() && validUrl(draft.url.trim()));

  return (
    <EditorSheet
      title={server ? "Edit MCP Server" : "New MCP Server"}
      error={save.error?.message}
      submitLabel={server ? "Save" : "Add"}
      submitDisabled={!valid || save.isPending}
      onSubmit={() => valid && save.mutate()}
      onClose={onClose}
    >
      <ServerFields bots={bots} server={server} draft={draft} patch={patch} />
      <OAuthAppFields server={server} draft={draft} patch={patch} />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="mcp-enabled">Enabled</FieldLabel>
        </FieldContent>
        <Switch
          id="mcp-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </Field>
    </EditorSheet>
  );
}

type DraftFieldsProps = {
  server: McpServer | null;
  draft: ServerDraft;
  patch: (change: Partial<ServerDraft>) => void;
};

function ServerFields({
  bots,
  server,
  draft,
  patch,
}: DraftFieldsProps & { bots: Bot[] }) {
  const owners = [
    { label: "Every bot (shared)", value: SHARED },
    ...bots.map((bot) => ({ label: bot.name, value: bot.id })),
  ];

  const urlInvalid = draft.url.trim() !== "" && !validUrl(draft.url.trim());

  return (
    <>
      <OwnerSelectField
        label="Available to"
        owners={owners}
        value={draft.owner}
        disabled={server !== null}
        onValueChange={(value) => patch({ owner: value ?? SHARED })}
      />
      <Field>
        <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
        <Input
          id="mcp-name"
          maxLength={100}
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>
      <Field data-invalid={urlInvalid || undefined}>
        <FieldLabel htmlFor="mcp-url">URL</FieldLabel>
        <Input
          id="mcp-url"
          type="url"
          placeholder="https://example.com/mcp"
          aria-invalid={urlInvalid || undefined}
          value={draft.url}
          onChange={(event) => patch({ url: event.target.value })}
        />
        {urlInvalid && (
          <FieldDescription>Use an HTTP or HTTPS URL.</FieldDescription>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-token">Token</FieldLabel>
        <Input
          id="mcp-token"
          type="password"
          autoComplete="off"
          placeholder={
            server?.auth === "token" ? "Replace the saved token" : "Optional"
          }
          value={draft.token}
          onChange={(event) => patch({ token: event.target.value })}
        />
        <FieldDescription>
          Sent as a bearer token. Leave it empty for servers that need no
          sign-in or use OAuth.
        </FieldDescription>
      </Field>
    </>
  );
}

function OAuthAppFields({ server, draft, patch }: DraftFieldsProps) {
  const callback = `${location.origin}/ui/oauth/callback`;

  return (
    <FieldSet>
      <FieldLegend variant="label">OAuth app</FieldLegend>
      <FieldDescription>
        Only for servers whose sign-in can't register Crumble, such as
        GitHub&apos;s. Register an OAuth app there with the callback URL{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs break-all">
          {callback}
        </code>{" "}
        and enter its client ID and secret.
      </FieldDescription>
      <Field>
        <FieldLabel htmlFor="mcp-client-id">Client ID</FieldLabel>
        <Input
          id="mcp-client-id"
          autoComplete="off"
          placeholder="Optional"
          value={draft.clientId}
          onChange={(event) => patch({ clientId: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-client-secret">Client secret</FieldLabel>
        <Input
          id="mcp-client-secret"
          type="password"
          autoComplete="off"
          disabled={!draft.clientId.trim()}
          placeholder={
            server?.hasOAuthClientSecret
              ? "Replace the saved secret"
              : "Optional"
          }
          value={draft.clientSecret}
          onChange={(event) => patch({ clientSecret: event.target.value })}
        />
        <FieldDescription>
          Stored encrypted and never shown again. Changing the app signs the
          server out.
        </FieldDescription>
      </Field>
    </FieldSet>
  );
}

/** Finishes an MCP server's OAuth sign-in after the provider redirects back to the web UI. */
export function OAuthCallback() {
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // StrictMode runs effects twice; a code can be exchanged only once.
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(location.search);
    const serverId = sessionStorage.getItem(OAUTH_SERVER_KEY);
    sessionStorage.removeItem(OAUTH_SERVER_KEY);
    const denied = params.get("error");

    if (denied) {
      setError(params.get("error_description") ?? denied);

      return;
    }

    const code = params.get("code");
    const state = params.get("state");
    const iss = params.get("iss");

    if (!serverId || !code || !state) {
      setError("This sign-in link is incomplete or was already used.");

      return;
    }

    send(`${serverPath(serverId)}/oauth/callback`, "POST", {
      code,
      state,
      ...(iss && { iss }),
    }).then(
      async () => {
        await refresh();
        await navigate({ to: "/settings/integrations", replace: true });
      },
      (failure: Error) => setError(failure.message),
    );
  }, [navigate]);

  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-4 p-6 text-center">
      {error ? (
        <>
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button
            variant="outline"
            render={<Link to="/settings/integrations" />}
            nativeButton={false}
          >
            Back to Integrations
          </Button>
        </>
      ) : (
        <>
          <Spinner />
          <p className="text-sm text-muted-foreground">Finishing sign-in…</p>
        </>
      )}
    </div>
  );
}

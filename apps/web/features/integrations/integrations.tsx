import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { UseNavigateResult } from "@tanstack/react-router";
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
import { RedirectReturn } from "@/components/redirect-return";
import {
  SecretSourceField,
  useSecretDraft,
} from "@/features/password-managers/secret-source-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { type Bot, botsQuery, refreshBots } from "@/features/bots/api";
import { type McpServer, mcpServersQuery, mcpServerPath } from "./api";
import { call, queryClient, send } from "@/lib/api";
import {
  ConfirmDeleteContent,
  NewButton,
  PageToolbar,
  RowMenu,
  RowTile,
  Section,
  SectionEmpty,
  Page,
} from "@/components/page";
import { BotAvatar } from "@/components/bot-avatar";
import { SHARED, ownerItems } from "@/features/bots/queries";
import { refreshSecrets } from "@/features/password-managers/api";
import { MAX_MCP_SERVER_NAME_CHARS } from "@crumble/server/contract/limits";
import { MCP_OAUTH_WEB_PATH } from "@crumble/server/contract/mcp-oauth";

const OAUTH_SERVER_KEY = "crumble.oauth.server";

async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: mcpServersQuery.queryKey }),
    refreshBots(),
    refreshSecrets(),
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

function botServers(bots: Bot[], list: McpServer[]) {
  return bots.flatMap((bot) => {
    const own = list.filter((server) => server.agentId === bot.id);

    return own.length ? [{ bot, servers: own }] : [];
  });
}

function IntegrationSections({
  shared,
  botOwn,
  onEdit,
}: {
  shared: McpServer[];
  botOwn: { bot: Bot; servers: McpServer[] }[];
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
      {botOwn.map(({ bot, servers: own }) => (
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
    <Page
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
          botOwn={botServers(bots.data ?? [], list)}
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
    </Page>
  );
}

function useServerActions(server: McpServer) {
  const signIn = useMutation({
    mutationFn: async () => {
      const result = await call<"oauth">(
        `${mcpServerPath(server.id)}/oauth`,
        "POST",
        { redirectUri: `${location.origin}${MCP_OAUTH_WEB_PATH}` },
      );

      if ("authorizationUrl" in result) {
        sessionStorage.setItem(OAUTH_SERVER_KEY, server.id);
        location.href = result.authorizationUrl;
      }
    },
    onSettled: refresh,
  });

  const signOut = useMutation({
    mutationFn: () =>
      send<"deleteOauth">(`${mcpServerPath(server.id)}/oauth`, "DELETE"),
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: () =>
      send<"deleteMcpServer">(mcpServerPath(server.id), "DELETE"),
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
      <ServerDetails server={server} failure={failure} onEdit={onEdit} />
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

function ServerDetails({
  server,
  failure,
  onEdit,
}: {
  server: McpServer;
  failure: string | undefined;
  onEdit: () => void;
}) {
  return (
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
  );
}

type ServerDraft = {
  owner: string;
  name: string;
  url: string;
  enabled: boolean;
  clientId: string;
};

const BLANK_DRAFT: ServerDraft = {
  owner: SHARED,
  name: "",
  url: "",
  enabled: true,
  clientId: "",
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

type ServerSecrets = {
  token: ReturnType<typeof useSecretDraft>;
  clientSecret: ReturnType<typeof useSecretDraft>;
};

function oauthClientPatch(
  draft: ServerDraft,
  server: McpServer | null,
  { clientSecret }: ServerSecrets,
) {
  const clientId = draft.clientId.trim();

  return {
    ...((clientId || server?.oauthClientId) && {
      oauthClientId: clientId || null,
    }),
    // Without an app, its secret has no use; clearing the client ID removes it too.
    ...(clientId && clientSecret.changed
      ? { oauthClientSecret: clientSecret.input }
      : !clientId &&
        server?.oauthClientSecret.configured && { oauthClientSecret: null }),
  };
}

function serverBody(
  draft: ServerDraft,
  server: McpServer | null,
  secrets: ServerSecrets,
) {
  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    enabled: draft.enabled,
    ...(secrets.token.changed && { token: secrets.token.input }),
    ...oauthClientPatch(draft, server, secrets),
  };
}

function useSaveServer(
  draft: ServerDraft,
  server: McpServer | null,
  secrets: ServerSecrets,
  onClose: () => void,
) {
  return useMutation({
    mutationFn: () => {
      const body = serverBody(draft, server, secrets);

      return server
        ? send<"updateMcpServer">(mcpServerPath(server.id), "PATCH", body)
        : send<"createMcpServer">("/v1/mcp-servers", "POST", {
            ...body,
            agentId: draft.owner === SHARED ? null : draft.owner,
          });
    },
    onSuccess: async () => {
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

  const secrets: ServerSecrets = {
    token: useSecretDraft(server?.token),
    clientSecret: useSecretDraft(server?.oauthClientSecret),
  };

  const save = useSaveServer(draft, server, secrets, onClose);

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
      <ServerFields
        bots={bots}
        server={server}
        draft={draft}
        patch={patch}
        secrets={secrets}
      />
      <OAuthAppFields
        server={server}
        draft={draft}
        patch={patch}
        secrets={secrets}
      />
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
  secrets: ServerSecrets;
};

function ServerFields({
  bots,
  server,
  draft,
  patch,
  secrets,
}: DraftFieldsProps & { bots: Bot[] }) {
  const urlInvalid = draft.url.trim() !== "" && !validUrl(draft.url.trim());

  return (
    <>
      <OwnerSelectField
        label="Available to"
        owners={ownerItems("Every bot (shared)", bots)}
        value={draft.owner}
        disabled={server !== null}
        onValueChange={(value) => patch({ owner: value ?? SHARED })}
      />
      <Field>
        <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
        <Input
          id="mcp-name"
          maxLength={MAX_MCP_SERVER_NAME_CHARS}
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
      <SecretSourceField
        id="mcp-token"
        label="Token"
        {...secrets.token.field}
        valuePlaceholder={
          server?.auth === "token" && !server.token.reference
            ? "Replace the saved token"
            : "Optional"
        }
        valueDescription="Sent as a bearer token. Leave it empty for servers that need no sign-in or use OAuth."
      />
    </>
  );
}

function OAuthAppFields({ server, draft, patch, secrets }: DraftFieldsProps) {
  const callback = `${location.origin}${MCP_OAUTH_WEB_PATH}`;

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
      <SecretSourceField
        id="mcp-client-secret"
        label="Client secret"
        {...secrets.clientSecret.field}
        disabled={!draft.clientId.trim()}
        valuePlaceholder={
          server?.oauthClientSecret.configured
            ? "Replace the saved secret"
            : "Optional"
        }
        valueDescription="Stored encrypted and never shown again. Changing the app signs the server out."
      />
    </FieldSet>
  );
}

/** Finishes an MCP server's OAuth sign-in after the provider redirects back to the web UI. */
function finishOAuth(
  params: URLSearchParams,
  navigate: UseNavigateResult<string>,
) {
  const serverId = sessionStorage.getItem(OAUTH_SERVER_KEY);
  sessionStorage.removeItem(OAUTH_SERVER_KEY);
  const denied = params.get("error");

  if (denied)
    return Promise.reject(new Error(params.get("error_description") ?? denied));

  const code = params.get("code");
  const state = params.get("state");
  const iss = params.get("iss");

  if (!serverId || !code || !state)
    return Promise.reject(
      new Error("This sign-in link is incomplete or was already used."),
    );

  return send<"oauthCallback">(
    `${mcpServerPath(serverId)}/oauth/callback`,
    "POST",
    {
      code,
      state,
      ...(iss && { iss }),
    },
  ).then(async () => {
    await refresh();
    await navigate({ to: "/settings/integrations", replace: true });
  });
}

export function OAuthCallback() {
  return (
    <RedirectReturn
      finish={finishOAuth}
      pending="Finishing sign-in…"
      backTo="/settings/integrations"
      backLabel="Back to Integrations"
    />
  );
}

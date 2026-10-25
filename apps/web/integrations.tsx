import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { OwnerSelectField, SaveDialogFooter } from "./form-fields";
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
} from "./api";
import {
  ConfirmDelete,
  Section,
  SectionEmpty,
  WorkspacePage,
} from "./workspace";

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
  if (server.auth === "oauth") return "Signed in with OAuth";

  return server.auth === "token" ? "Uses a token" : "No sign-in";
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

export function IntegrationsPage() {
  const bots = useQuery(botsQuery);
  const servers = useQuery(mcpServersQuery);
  const [editing, setEditing] = useState<Editing | null>(null);
  const list = servers.data ?? [];

  const shared = list.filter((server) => server.agentId === null);

  const personal = (bots.data ?? []).flatMap((bot) => {
    const own = list.filter((server) => server.agentId === bot.id);

    return own.length ? [{ bot, servers: own }] : [];
  });

  return (
    <WorkspacePage
      title="Integrations"
      refreshing={bots.isFetching || servers.isFetching}
      onRefresh={() => void refresh()}
      newLabel="New MCP server"
      onNew={() => setEditing({ server: null })}
    >
      {servers.isPending || bots.isPending ? (
        <Skeleton className="h-40" />
      ) : servers.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{servers.error.message}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Section
            title="Shared"
            footer="Shared MCP servers can be turned on for any bot in its profile."
          >
            {shared.length === 0 && (
              <SectionEmpty>No shared MCP servers yet.</SectionEmpty>
            )}
            {shared.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                owner={null}
                onEdit={() => setEditing({ server })}
              />
            ))}
          </Section>
          {personal.map(({ bot, servers: own }) => (
            <Section key={bot.id} title={`Only ${bot.name}`}>
              {own.map((server) => (
                <ServerRow
                  key={server.id}
                  server={server}
                  owner={bot}
                  onEdit={() => setEditing({ server })}
                />
              ))}
            </Section>
          ))}
        </>
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

function ServerRow({
  server,
  owner,
  onEdit,
}: {
  server: McpServer;
  owner: Bot | null;
  onEdit: () => void;
}) {
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

  const failure = signIn.error ?? signOut.error ?? remove.error;

  return (
    <div className="flex items-start gap-3 p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {server.name}
          {!server.enabled && <Badge variant="outline">Disabled</Badge>}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {server.url}
        </span>
        <span className="text-xs text-muted-foreground">
          {owner ? `Only ${owner.name}` : "Shared"} · {authLabel(server)}
        </span>
        {server.error && (
          <span className="text-xs text-destructive">{server.error}</span>
        )}
        {failure && (
          <span className="text-xs text-destructive">{failure.message}</span>
        )}
      </div>
      {server.auth === "oauth" ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign Out
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={signIn.isPending}
          onClick={() => signIn.mutate()}
        >
          {signIn.isPending && <Spinner data-icon="inline-start" />}
          Sign In…
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" title="Edit" onClick={onEdit}>
        <HugeiconsIcon icon={PencilEdit01Icon} />
      </Button>
      <ConfirmDelete
        title={`Delete ${server.name}?`}
        description="Bots lose its tools and its sign-in is removed. This cannot be undone."
        onConfirm={() => remove.mutate()}
        trigger={
          <Button variant="ghost" size="icon-sm" title="Delete">
            <HugeiconsIcon icon={Delete02Icon} />
          </Button>
        }
      />
    </div>
  );
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
  const [owner, setOwner] = useState(server?.agentId ?? SHARED);
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [tokenValue, setTokenValue] = useState("");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [clientId, setClientId] = useState(server?.oauthClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const callback = `${location.origin}/ui/oauth/callback`;

  const owners = [
    { label: "Every bot (shared)", value: SHARED },
    ...bots.map((bot) => ({ label: bot.name, value: bot.id })),
  ];

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        url: url.trim(),
        enabled,
        ...(tokenValue.trim() && { token: tokenValue.trim() }),
        ...((clientId.trim() || server?.oauthClientId) && {
          oauthClientId: clientId.trim() || null,
        }),
        // Without an app, its secret has no use; clearing the client ID removes it too.
        ...(clientSecret.trim()
          ? { oauthClientSecret: clientSecret.trim() }
          : !clientId.trim() &&
            server?.hasOAuthClientSecret && { oauthClientSecret: "" }),
      };

      return server
        ? send(serverPath(server.id), "PATCH", body)
        : send("/v1/mcp-servers", "POST", {
            ...body,
            agentId: owner === SHARED ? null : owner,
          });
    },
    onSuccess: async () => {
      setTokenValue("");
      setClientSecret("");
      await refresh();
      onClose();
    },
  });

  const urlInvalid = url.trim() !== "" && !validUrl(url.trim());

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {server ? "Edit MCP Server" : "New MCP Server"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();

            if (name.trim() && validUrl(url.trim())) save.mutate();
          }}
        >
          <FieldGroup>
            <OwnerSelectField
              label="Available to"
              owners={owners}
              value={owner}
              disabled={server !== null}
              onValueChange={(value) => setOwner(value ?? SHARED)}
            />
            <Field>
              <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
              <Input
                id="mcp-name"
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field data-invalid={urlInvalid || undefined}>
              <FieldLabel htmlFor="mcp-url">URL</FieldLabel>
              <Input
                id="mcp-url"
                type="url"
                placeholder="https://example.com/mcp"
                aria-invalid={urlInvalid || undefined}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
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
                  server?.auth === "token"
                    ? "Replace the saved token"
                    : "Optional"
                }
                value={tokenValue}
                onChange={(event) => setTokenValue(event.target.value)}
              />
              <FieldDescription>
                Sent as a bearer token. Leave it empty for servers that need no
                sign-in or use OAuth.
              </FieldDescription>
            </Field>
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
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="mcp-client-secret">
                  Client secret
                </FieldLabel>
                <Input
                  id="mcp-client-secret"
                  type="password"
                  autoComplete="off"
                  disabled={!clientId.trim()}
                  placeholder={
                    server?.hasOAuthClientSecret
                      ? "Replace the saved secret"
                      : "Optional"
                  }
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
                <FieldDescription>
                  Stored encrypted and never shown again. Changing the app signs
                  the server out.
                </FieldDescription>
              </Field>
            </FieldSet>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="mcp-enabled">Enabled</FieldLabel>
              </FieldContent>
              <Switch
                id="mcp-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </Field>
            <SaveDialogFooter
              error={save.isError ? save.error : null}
              onCancel={onClose}
              disabled={!name.trim() || !validUrl(url.trim()) || save.isPending}
              label={server ? "Save" : "Add"}
            />
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
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

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { UseNavigateResult } from "@tanstack/react-router";
import { IconBrandGithub } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RedirectReturn } from "@/components/redirect-return";
import { Spinner } from "@/components/ui/spinner";
import {
  type GitHubApp,
  type GitHubAppManifest,
  call,
  credentialsQuery,
  githubAppPath,
  githubAppQuery,
  queryClient,
  send,
} from "@/lib/api";

/** The bot whose App GitHub sends the owner back for; GitHub's redirect carries no bot. */
const GITHUB_APP_BOT_KEY = "crumble.github-app.bot";

const refresh = (botId: string) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: githubAppQuery(botId).queryKey }),
    queryClient.invalidateQueries({
      queryKey: credentialsQuery(botId).queryKey,
    }),
  ]);

/** GitHub creates an App only from a form post with the manifest, so the browser leaves for github.com here. */
function postManifest({ url, manifest }: GitHubAppManifest) {
  const form = document.createElement("form");
  const field = document.createElement("input");

  form.method = "post";
  form.action = url;
  field.type = "hidden";
  field.name = "manifest";
  field.value = manifest;
  form.append(field);
  document.body.append(form);
  form.submit();
}

function useGitHubAppActions(botId: string) {
  const create = useMutation({
    mutationFn: async (organization: string) => {
      const started = await call<
        GitHubAppManifest,
        { origin: string; organization?: string }
      >(`${githubAppPath(botId)}/manifest`, "POST", {
        origin: location.origin,
        ...(organization && { organization }),
      });

      sessionStorage.setItem(GITHUB_APP_BOT_KEY, botId);
      postManifest(started);
    },
  });

  const connect = useMutation({
    mutationFn: () => send(`${githubAppPath(botId)}/connect`, "POST"),
    onSettled: () => refresh(botId),
  });

  const remove = useMutation({
    mutationFn: () => send(githubAppPath(botId), "DELETE"),
    onSettled: () => refresh(botId),
  });

  return { create, connect, remove };
}

function CreateApp({
  actions,
}: {
  actions: ReturnType<typeof useGitHubAppActions>;
}) {
  const [organization, setOrganization] = useState("");

  return (
    <>
      <Input
        aria-label="GitHub organization"
        className="h-8 w-40"
        placeholder="Your account"
        value={organization}
        onChange={(event) => setOrganization(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={actions.create.isPending}
        onClick={() => actions.create.mutate(organization.trim())}
      >
        Create App
      </Button>
    </>
  );
}

function AppActions({
  botId,
  app,
  actions,
}: {
  botId: string;
  app: GitHubApp;
  actions: ReturnType<typeof useGitHubAppActions>;
}) {
  return (
    <>
      {!app.installedOn && (
        <>
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            // Same tab: GitHub returns to /ui/github-app/installed, which reads the bot from this tab's sessionStorage.
            onClick={() => sessionStorage.setItem(GITHUB_APP_BOT_KEY, botId)}
            render={<a href={app.installUrl} />}
          >
            Install
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={actions.connect.isPending}
            onClick={() => actions.connect.mutate()}
          >
            Check
          </Button>
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={actions.remove.isPending}
        onClick={() => actions.remove.mutate()}
      >
        Remove
      </Button>
    </>
  );
}

function AppName({ app }: { app: GitHubApp | null | undefined }) {
  if (!app) return <span className="min-w-0 flex-1 text-sm">GitHub</span>;

  return (
    <span className="min-w-0 flex-1 truncate text-sm">
      <a
        href={app.htmlUrl}
        target="_blank"
        rel="noreferrer"
        className="hover:underline"
      >
        {app.login}
      </a>
      {app.installedOn && (
        <span className="text-muted-foreground"> on {app.installedOn}</span>
      )}
    </span>
  );
}

/** The bot's own GitHub identity: commits, pushes, and pull requests from its coding jobs show as its App. */
export function GitHubAppRow({ botId }: { botId: string }) {
  const status = useQuery(githubAppQuery(botId));
  const actions = useGitHubAppActions(botId);
  const app = status.data?.app;

  const failure = [actions.create, actions.connect, actions.remove].find(
    (action) => action.error,
  )?.error;

  return (
    <div className="flex flex-col gap-2 bg-muted/30 py-2.5 pr-3 pl-8">
      <div className="flex items-center gap-2">
        <IconBrandGithub className="size-4 shrink-0" />
        <AppName app={app} />
        {status.isPending && <Spinner />}
        {app && <AppActions botId={botId} app={app} actions={actions} />}
        {status.isSuccess && !app && <CreateApp actions={actions} />}
      </div>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Where GitHub sends the owner back: after creating the App with a code, and after installing it without one. */
function finishGitHubApp(
  params: URLSearchParams,
  navigate: UseNavigateResult<string>,
) {
  const botId = sessionStorage.getItem(GITHUB_APP_BOT_KEY);
  const code = params.get("code");
  const state = params.get("state");
  const installed = location.pathname.endsWith("/installed");

  if (!botId || (!installed && (!code || !state)))
    return Promise.reject(
      new Error("This GitHub link is incomplete or was already used."),
    );

  const finish = installed
    ? send(`${githubAppPath(botId)}/connect`, "POST")
    : send(`${githubAppPath(botId)}/complete`, "POST", { code, state });

  return finish.then(async () => {
    if (installed) sessionStorage.removeItem(GITHUB_APP_BOT_KEY);
    await refresh(botId);
    await navigate({
      to: "/bots/$botId/edit",
      params: { botId },
      replace: true,
    });
  });
}

export function GitHubAppCallback() {
  return (
    <RedirectReturn
      finish={finishGitHubApp}
      pending="Finishing GitHub setup…"
      backTo="/"
      backLabel="Back to Crumble"
    />
  );
}

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { UseNavigateResult } from "@tanstack/react-router";
import { IconBrandGithub, IconPencil, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { EditorSheet } from "@/components/form-fields";
import { RedirectReturn } from "@/components/redirect-return";
import {
  ConfirmDelete,
  NewButton,
  RowTile,
  Section,
  SectionEmpty,
  SettingRow,
  WorkspacePage,
} from "@/components/workspace";
import {
  type Bot,
  type GitHubApp,
  type GitHubAppManifest,
  botsQuery,
  call,
  githubAppPath,
  githubAppsQuery,
  queryClient,
  send,
} from "@/lib/api";
import { BotAvatar } from "@/features/bots/avatar";

/** The App GitHub sends the owner back for after installing; GitHub's redirect doesn't say which. */
const INSTALLING_KEY = "crumble.github-app.installing";

// A bot's GH_TOKEN appears or goes with its Apps, so credentials refresh too.
const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: githubAppsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ["credentials"] }),
  ]).then(() => undefined);

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

function GitHubTile() {
  return (
    <RowTile>
      <IconBrandGithub />
    </RowTile>
  );
}

function InstallButton({ app }: { app: GitHubApp }) {
  return (
    <Button
      size="sm"
      variant="outline"
      nativeButton={false}
      // Same tab: GitHub returns to /ui/github-app/installed, which reads the App from this tab's sessionStorage.
      onClick={() => sessionStorage.setItem(INSTALLING_KEY, app.id)}
      render={<a href={app.installUrl} />}
    >
      Install
    </Button>
  );
}

function AppRow({ app, onEdit }: { app: GitHubApp; onEdit: () => void }) {
  const remove = useMutation({
    mutationFn: () => send(githubAppPath(app.id), "DELETE"),
    onSuccess: refresh,
  });

  return (
    <SettingRow
      tile={<GitHubTile />}
      title={
        <>
          <span className="truncate">{app.login}</span>
          <span className="font-normal text-muted-foreground">
            (used by {app.botIds.length})
          </span>
        </>
      }
      description={remove.error?.message}
    >
      {!app.installed && <InstallButton app={app} />}
      <Button variant="ghost" size="icon-sm" title="Edit" onClick={onEdit}>
        <IconPencil />
      </Button>
      <ConfirmDelete
        title={`Remove ${app.login}?`}
        description="Its bots lose access to GitHub through it. The App stays on GitHub; delete it in its settings there."
        onConfirm={() => remove.mutate()}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            title="Remove"
            disabled={remove.isPending}
          >
            <IconTrash />
          </Button>
        }
      />
    </SettingRow>
  );
}

function CreateAppSheet({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [organization, setOrganization] = useState("");

  const create = useMutation({
    mutationFn: async () =>
      postManifest(
        await call<
          GitHubAppManifest,
          { name: string; origin: string; organization?: string }
        >("/v1/github-apps/manifest", "POST", {
          name: name.trim(),
          origin: location.origin,
          ...(organization.trim() && { organization: organization.trim() }),
        }),
      ),
  });

  return (
    <EditorSheet
      title="New GitHub App"
      description="GitHub opens to create a private App on one account. Bots you assign to it commit and open pull requests as it in that account's repositories."
      error={create.error?.message}
      submitLabel="Create on GitHub"
      submitDisabled={!name.trim() || create.isPending}
      onSubmit={() => create.mutate()}
      onClose={onClose}
    >
      <Field>
        <FieldLabel htmlFor="github-app-name">Name</FieldLabel>
        <Input
          id="github-app-name"
          placeholder="frien-bot"
          maxLength={34}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <FieldDescription>
          Unique across GitHub. Commits show it as name[bot].
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="github-app-organization">Organization</FieldLabel>
        <Input
          id="github-app-organization"
          placeholder="Your account"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
        />
        <FieldDescription>
          The App can only work in its owner's repositories. Create one App per
          account.
        </FieldDescription>
      </Field>
    </EditorSheet>
  );
}

function BotToggle({
  bot,
  checked,
  onChange,
}: {
  bot: Bot;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label
      htmlFor={`github-app-bot-${bot.id}`}
      className="flex cursor-pointer items-center gap-3 py-1.5"
    >
      <BotAvatar bot={bot} size={22} />
      <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
      <Switch
        id={`github-app-bot-${bot.id}`}
        checked={checked}
        onCheckedChange={onChange}
      />
    </label>
  );
}

function InstallationField({ app }: { app: GitHubApp }) {
  const connect = useMutation({
    mutationFn: () => send(`${githubAppPath(app.id)}/connect`, "POST"),
    onSuccess: refresh,
  });

  return (
    <Field>
      <FieldLabel>Installation</FieldLabel>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-sm">
          {app.installed
            ? `Installed on ${app.account}`
            : `Not installed${app.account ? ` on ${app.account}` : ""}`}
        </span>
        {!app.installed && <InstallButton app={app} />}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={connect.isPending}
          onClick={() => connect.mutate()}
        >
          {connect.isPending && <Spinner data-icon="inline-start" />}
          Check
        </Button>
      </div>
      {connect.error && <FieldError>{connect.error.message}</FieldError>}
    </Field>
  );
}

function AppSheet({ app, onClose }: { app: GitHubApp; onClose: () => void }) {
  const bots = useQuery(botsQuery);
  const [botIds, setBotIds] = useState(app.botIds);

  const save = useMutation({
    mutationFn: () =>
      call<GitHubApp, { botIds: string[] }>(
        `${githubAppPath(app.id)}/bots`,
        "PUT",
        { botIds },
      ),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  const toggle = (botId: string, on: boolean) =>
    setBotIds((current) =>
      on ? [...current, botId] : current.filter((id) => id !== botId),
    );

  return (
    <EditorSheet
      title={app.login}
      description={
        <a
          href={app.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          Open on GitHub
        </a>
      }
      error={save.error?.message}
      submitLabel="Save"
      submitDisabled={save.isPending}
      onSubmit={() => save.mutate()}
      onClose={onClose}
    >
      <InstallationField app={app} />
      <Field>
        <FieldLabel>Bots</FieldLabel>
        <FieldDescription>
          They get GH_TOKEN once the App is installed. A bot uses one App per
          GitHub account; its first App is its default for commits and gh pr.
        </FieldDescription>
        <div className="flex flex-col">
          {bots.data?.map((bot) => (
            <BotToggle
              key={bot.id}
              bot={bot}
              checked={botIds.includes(bot.id)}
              onChange={(on) => toggle(bot.id, on)}
            />
          ))}
        </div>
      </Field>
    </EditorSheet>
  );
}

function AppsSection() {
  const apps = useQuery(githubAppsQuery);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const edited = apps.data?.find((app) => app.id === editing);

  return (
    <Section
      title="GitHub Apps"
      description="Each App is a GitHub identity in one account. Bots assigned to it push, commit, and open pull requests as it there."
      action={
        <NewButton label="New GitHub App" onClick={() => setCreating(true)} />
      }
    >
      {apps.isError && (
        <div className="p-3">
          <FieldError>{apps.error.message}</FieldError>
        </div>
      )}
      {apps.data?.length === 0 && (
        <SectionEmpty>No GitHub Apps yet.</SectionEmpty>
      )}
      {apps.data?.map((app) => (
        <AppRow key={app.id} app={app} onEdit={() => setEditing(app.id)} />
      ))}
      {creating && <CreateAppSheet onClose={() => setCreating(false)} />}
      {edited && <AppSheet app={edited} onClose={() => setEditing(null)} />}
    </Section>
  );
}

/** What the account's coding jobs work with: for now, the GitHub Apps bots act through. */
export function CodingPage() {
  const apps = useQuery(githubAppsQuery);

  return (
    <WorkspacePage
      title="Coding"
      onRefresh={() => void refresh()}
      refreshing={apps.isFetching}
    >
      <AppsSection />
    </WorkspacePage>
  );
}

/** Where GitHub sends the owner back: after creating an App with a code, and after installing one without. */
function finishGitHubApp(
  params: URLSearchParams,
  navigate: UseNavigateResult<string>,
) {
  const installing = sessionStorage.getItem(INSTALLING_KEY);
  const code = params.get("code");
  const state = params.get("state");
  const installed = location.pathname.endsWith("/installed");

  const finish = installed
    ? installing && send(`${githubAppPath(installing)}/connect`, "POST")
    : code &&
      state &&
      send("/v1/github-apps/complete", "POST", { code, state });

  if (!finish)
    return Promise.reject(
      new Error("This GitHub link is incomplete or was already used."),
    );

  return finish.then(async () => {
    sessionStorage.removeItem(INSTALLING_KEY);
    await refresh();
    await navigate({ to: "/settings/coding", replace: true });
  });
}

export function GitHubAppCallback() {
  return (
    <RedirectReturn
      finish={finishGitHubApp}
      pending="Finishing GitHub setup…"
      backTo="/settings/coding"
      backLabel="Back to Coding"
    />
  );
}

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
import { CopyButton, EditorSheet } from "@/components/form-fields";
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
            ({app.user && `as ${app.user}, `}used by {app.botIds.length})
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
  id,
  bot,
  checked,
  onChange,
}: {
  id: string;
  bot: Bot;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-3 py-1.5"
    >
      <BotAvatar bot={bot} size={22} />
      <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/** The bots that act as one GitHub identity, switched on and off in its sheet. */
function BotsField({
  botIds,
  onChange,
  description,
}: {
  botIds: string[];
  onChange: (botIds: string[]) => void;
  description: string;
}) {
  const bots = useQuery(botsQuery);

  return (
    <Field>
      <FieldLabel>Bots</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
      <div className="flex flex-col">
        {bots.data?.map((bot) => (
          <BotToggle
            key={bot.id}
            id={`github-bot-${bot.id}`}
            bot={bot}
            checked={botIds.includes(bot.id)}
            onChange={(on) =>
              onChange(
                on
                  ? [...botIds, bot.id]
                  : botIds.filter((each) => each !== bot.id),
              )
            }
          />
        ))}
      </div>
    </Field>
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

/** Where GitHub sends the owner back after signing in; every App lists it as a callback URL. */
const authorizedUrl = () => `${location.origin}/ui/github-app/authorized`;

/** GitHub refuses the sign-in until the App lists this URL; Apps Crumble creates already do. */
function CallbackUrl() {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Callback URL</span>
      <code className="min-w-0 flex-1 truncate text-xs">{authorizedUrl()}</code>
      <CopyButton text={authorizedUrl()} />
    </div>
  );
}

function ClientSecretForm({ app }: { app: GitHubApp }) {
  const [clientSecret, setClientSecret] = useState("");

  const save = useMutation({
    mutationFn: () =>
      call<GitHubApp, { clientSecret: string }>(
        `${githubAppPath(app.id)}/client-secret`,
        "PUT",
        { clientSecret: clientSecret.trim() },
      ),
    onSuccess: refresh,
  });

  return (
    <>
      <FieldDescription>
        To let bots act as you, open the App's settings on GitHub, add the
        callback URL above, and generate a client secret.
      </FieldDescription>
      <div className="flex gap-2">
        <Input
          type="password"
          aria-label="Client secret"
          autoComplete="off"
          placeholder="Client secret"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!clientSecret.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      </div>
      {save.error && <FieldError>{save.error.message}</FieldError>}
    </>
  );
}

/** Whether the App's bots act as the App's `slug[bot]` user or as the owner, signed in through the App. */
function ActAsField({ app }: { app: GitHubApp }) {
  const signIn = useMutation({
    mutationFn: async () => {
      const { url } = await call<{ url: string }, { origin: string }>(
        `${githubAppPath(app.id)}/sign-in`,
        "POST",
        { origin: location.origin },
      );

      location.assign(url);
    },
  });

  const signOut = useMutation({
    mutationFn: () => send(`${githubAppPath(app.id)}/user`, "DELETE"),
    onSuccess: refresh,
  });

  const error = signIn.error ?? signOut.error;

  return (
    <Field>
      <FieldLabel>Bots act as</FieldLabel>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-sm">
          {app.user ? `${app.user}, marked as ${app.login}` : app.login}
        </span>
        {app.user ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            Sign out
          </Button>
        ) : (
          app.hasClientSecret && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={signIn.isPending}
              onClick={() => signIn.mutate()}
            >
              {signIn.isPending && <Spinner data-icon="inline-start" />}
              Sign in as me
            </Button>
          )
        )}
      </div>
      {app.user && (
        <FieldDescription>
          GitHub shows their pull requests and comments with the App's badge,
          and their commits list {app.login} as co-author.
        </FieldDescription>
      )}
      {!app.user && <CallbackUrl />}
      {!app.user && !app.hasClientSecret && <ClientSecretForm app={app} />}
      {error && <FieldError>{error.message}</FieldError>}
    </Field>
  );
}

function AppSheet({ app, onClose }: { app: GitHubApp; onClose: () => void }) {
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

  return (
    <EditorSheet
      title={app.login}
      description={<GitHubLink href={app.htmlUrl} />}
      error={save.error?.message}
      submitLabel="Save"
      submitDisabled={save.isPending}
      onSubmit={() => save.mutate()}
      onClose={onClose}
    >
      <InstallationField app={app} />
      <ActAsField app={app} />
      <BotsField
        botIds={botIds}
        onChange={setBotIds}
        description="They get GH_TOKEN once the App is installed. A bot uses one App per GitHub account; its first App is its default for commits and gh pr."
      />
    </EditorSheet>
  );
}

function GitHubLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2"
    >
      Open on GitHub
    </a>
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

/** What the account's coding jobs work with: for now, the GitHub identities bots act as. */
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

/** Where GitHub sends the owner back: after creating an App or signing in through one with a code, and after installing one without. */
function finishGitHubApp(
  params: URLSearchParams,
  navigate: UseNavigateResult<string>,
) {
  const installing = sessionStorage.getItem(INSTALLING_KEY);
  const code = params.get("code");
  const state = params.get("state");
  const step = location.pathname.split("/").at(-1);

  const finish =
    step === "installed"
      ? installing && send(`${githubAppPath(installing)}/connect`, "POST")
      : code &&
        state &&
        send(
          step === "authorized"
            ? "/v1/github-apps/sign-in/complete"
            : "/v1/github-apps/complete",
          "POST",
          { code, state },
        );

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

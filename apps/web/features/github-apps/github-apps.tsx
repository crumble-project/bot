import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { UseNavigateResult } from "@tanstack/react-router";
import { IconBrandGithub, IconPencil, IconTrash } from "@tabler/icons-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { CopyButton, EditorSheet } from "@/components/form-fields";
import {
  SecretSourceField,
  type SecretInput,
  useSecretDraft,
} from "@/features/password-managers/secret-source-field";
import { RedirectReturn } from "@/components/redirect-return";
import {
  ConfirmDelete,
  NewButton,
  RowTile,
  Section,
  SectionEmpty,
  SectionError,
  SettingRow,
  UsedBy,
} from "@/components/page";
import { botsQuery } from "@/features/bots/api";
import {
  type GitHubAccount,
  type GitHubApp,
  type GitHubAppManifest,
  githubAccountPath,
  githubAccountsQuery,
  githubAppPath,
  githubAppsQuery,
  refreshGithub,
} from "./api";
import { call, send } from "@/lib/api";
import {
  GITHUB_APP_WEB_PATHS,
  MAX_GITHUB_APP_NAME_CHARS,
} from "@crumble/server/contract/github-apps";
import { BotSwitchField } from "@/features/bots/bot-switch-field";

/** Which of the pages in `GITHUB_APP_WEB_PATHS` GitHub sent the owner back to. */
type GitHubAppStep = keyof typeof GITHUB_APP_WEB_PATHS;

/** The App GitHub sends the owner back for after installing; GitHub's redirect doesn't say which. */
const INSTALLING_KEY = "crumble.github-app.installing";

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
    <a
      href={app.installUrl}
      className={buttonVariants({ size: "sm", variant: "outline" })}
      // Same tab: GitHub returns to /github-app/installed, which reads the App from this tab's sessionStorage.
      onClick={() => sessionStorage.setItem(INSTALLING_KEY, app.id)}
    >
      Install
    </a>
  );
}

function AppRow({ app, onEdit }: { app: GitHubApp; onEdit: () => void }) {
  const remove = useMutation({
    mutationFn: () => send<"deleteGithubApp">(githubAppPath(app.id), "DELETE"),
    onSuccess: refreshGithub,
  });

  return (
    <SettingRow
      tile={<GitHubTile />}
      title={
        <>
          <span className="truncate">{app.login}</span>
          <UsedBy
            count={app.botIds.length}
            prefix={app.user ? `as ${app.user}, ` : undefined}
          />
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

  // Success leaves the page for GitHub, so there is no cached data to refresh.
  // react-doctor-disable-next-line query-mutation-missing-invalidation
  const create = useMutation({
    mutationFn: async () =>
      postManifest(
        await call<"createGithubAppManifest">(
          "/v1/github-apps/manifest",
          "POST",
          {
            name: name.trim(),
            origin: location.origin,
            ...(organization.trim() && { organization: organization.trim() }),
          },
        ),
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
          maxLength={MAX_GITHUB_APP_NAME_CHARS}
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
  const selected = new Set(botIds);

  return (
    <Field>
      <FieldLabel>Bots</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
      <div className="flex flex-col gap-3">
        {bots.data?.map((bot) => (
          <BotSwitchField
            key={bot.id}
            id={`github-bot-${bot.id}`}
            bot={bot}
            checked={selected.has(bot.id)}
            onCheckedChange={(on) =>
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
    mutationFn: () =>
      send<"connectGithubApp">(`${githubAppPath(app.id)}/connect`, "POST"),
    onSuccess: refreshGithub,
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
const authorizedUrl = () =>
  `${location.origin}${GITHUB_APP_WEB_PATHS.authorized}`;

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
  const secret = useSecretDraft(app.clientSecret);

  const save = useMutation({
    mutationFn: (body: SecretInput) =>
      call<"setGithubAppClientSecret">(
        `${githubAppPath(app.id)}/client-secret`,
        "PUT",
        body,
      ),
    onSuccess: refreshGithub,
  });

  return (
    <>
      <SecretSourceField
        id={`github-app-client-secret-${app.id}`}
        label="Client secret"
        {...secret.field}
        valueDescription="To let bots act as you, open the App's settings on GitHub, add the callback URL above, and generate a client secret."
      />
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={!secret.changed || save.isPending}
        onClick={() => secret.input && save.mutate(secret.input)}
      >
        Save
      </Button>
      {save.error && <FieldError>{save.error.message}</FieldError>}
    </>
  );
}

function SignInButton({ app }: { app: GitHubApp }) {
  const signIn = useMutation({
    mutationFn: async () => {
      const { url } = await call<"signInGithubApp">(
        `${githubAppPath(app.id)}/sign-in`,
        "POST",
        { origin: location.origin },
      );

      location.assign(url);
    },
  });

  return (
    <>
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
      {signIn.error && <FieldError>{signIn.error.message}</FieldError>}
    </>
  );
}

function SignOutButton({ app }: { app: GitHubApp }) {
  const signOut = useMutation({
    mutationFn: () =>
      send<"signOutGithubApp">(`${githubAppPath(app.id)}/user`, "DELETE"),
    onSuccess: refreshGithub,
  });

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={signOut.isPending}
        onClick={() => signOut.mutate()}
      >
        Sign out
      </Button>
      {signOut.error && <FieldError>{signOut.error.message}</FieldError>}
    </>
  );
}

/** Whether the App's bots act as the App's `slug[bot]` user or as the owner, signed in through the App. */
function ActAsField({ app }: { app: GitHubApp }) {
  if (app.user)
    return (
      <Field>
        <FieldLabel>Bots act as</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-sm">
            {app.user}, marked as {app.login}
          </span>
          <SignOutButton app={app} />
        </div>
        <FieldDescription>
          GitHub shows their pull requests and comments with the App's badge,
          and their commits list {app.login} as co-author.
        </FieldDescription>
      </Field>
    );

  return (
    <Field>
      <FieldLabel>Bots act as</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm">{app.login}</span>
        {app.clientSecret.configured && <SignInButton app={app} />}
      </div>
      <CallbackUrl />
      {!app.clientSecret.configured && <ClientSecretForm app={app} />}
    </Field>
  );
}

function AppSheet({ app, onClose }: { app: GitHubApp; onClose: () => void }) {
  const [botIds, setBotIds] = useState(app.botIds);

  const save = useMutation({
    mutationFn: () =>
      call<"setGithubAppBots">(`${githubAppPath(app.id)}/bots`, "PUT", {
        botIds,
      }),
    onSuccess: async () => {
      await refreshGithub();
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

export function AppsSection() {
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
      {apps.isError && <SectionError>{apps.error.message}</SectionError>}
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

function AccountRow({
  account,
  onEdit,
}: {
  account: GitHubAccount;
  onEdit: () => void;
}) {
  const remove = useMutation({
    mutationFn: () =>
      send<"deleteGithubAccount">(githubAccountPath(account.id), "DELETE"),
    onSuccess: refreshGithub,
  });

  return (
    <SettingRow
      tile={<GitHubTile />}
      title={
        <>
          <span className="truncate">{account.login}</span>
          <UsedBy count={account.botIds.length} />
        </>
      }
      description={remove.error?.message}
    >
      <Button variant="ghost" size="icon-sm" title="Edit" onClick={onEdit}>
        <IconPencil />
      </Button>
      <ConfirmDelete
        title={`Remove ${account.login}?`}
        description="Crumble forgets its token and its bots stop acting as it. The user stays on GitHub; revoke the token there too."
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

function TokenField({
  token,
  label,
}: {
  token: ReturnType<typeof useSecretDraft>;
  label: string;
}) {
  return (
    <SecretSourceField
      id="github-account-token"
      label={label}
      {...token.field}
      valuePlaceholder="github_pat_…"
      valueDescription={
        <>
          Signed in as the machine account on GitHub, create a personal access
          token with access to the repositories its bots work in.{" "}
          <a
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            New token
          </a>
        </>
      }
    />
  );
}

function AddAccountSheet({ onClose }: { onClose: () => void }) {
  const token = useSecretDraft();

  const add = useMutation({
    mutationFn: (body: SecretInput) =>
      call<"addGithubAccount">("/v1/github-accounts", "POST", body),
    onSuccess: async () => {
      await refreshGithub();
      onClose();
    },
  });

  return (
    <EditorSheet
      title="New machine account"
      description="A GitHub user you made for your bots. They act as it wherever none of their Apps does, such as other people's repositories."
      error={add.error?.message}
      submitLabel="Add"
      submitDisabled={!token.input || add.isPending}
      onSubmit={() => token.input && add.mutate(token.input)}
      onClose={onClose}
    >
      <TokenField token={token} label="Token" />
    </EditorSheet>
  );
}

function AccountSheet({
  account,
  onClose,
}: {
  account: GitHubAccount;
  onClose: () => void;
}) {
  const [botIds, setBotIds] = useState(account.botIds);
  const token = useSecretDraft(account.token);

  const save = useMutation({
    mutationFn: async () => {
      if (token.input && token.changed)
        await call<"setGithubAccountToken">(
          `${githubAccountPath(account.id)}/token`,
          "PUT",
          token.input,
        );

      await call<"setGithubAccountBots">(
        `${githubAccountPath(account.id)}/bots`,
        "PUT",
        { botIds },
      );
    },
    onSuccess: async () => {
      await refreshGithub();
      onClose();
    },
  });

  return (
    <EditorSheet
      title={account.login}
      description={<GitHubLink href={account.htmlUrl} />}
      error={save.error?.message}
      submitLabel="Save"
      submitDisabled={save.isPending}
      onSubmit={() => save.mutate()}
      onClose={onClose}
    >
      <BotsField
        botIds={botIds}
        onChange={setBotIds}
        description="They get GH_TOKEN and act as this user wherever none of their Apps does; their commits default to it. A bot acts as one machine account."
      />
      <TokenField
        token={token}
        label={account.token.passwordManager ? "Token" : "Replace token"}
      />
      <Field>
        <FieldLabel htmlFor="github-account-signing-key">
          Signing key
        </FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id="github-account-signing-key"
            readOnly
            className="font-mono"
            value={account.signingKey}
          />
          <CopyButton text={account.signingKey} />
        </div>
        <FieldDescription>
          Commits its bots make are signed with this key. Add it to{" "}
          {account.login} on GitHub as a signing key so they show as verified.{" "}
          <a
            className="underline underline-offset-2"
            href="https://github.com/settings/ssh/new"
            target="_blank"
            rel="noreferrer"
          >
            Add key
          </a>
        </FieldDescription>
      </Field>
    </EditorSheet>
  );
}

export function AccountsSection() {
  const accounts = useQuery(githubAccountsQuery);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const edited = accounts.data?.find((account) => account.id === editing);

  return (
    <Section
      title="Machine accounts"
      description="GitHub users for your bots to act as wherever none of their Apps does."
      action={
        <NewButton
          label="New machine account"
          onClick={() => setAdding(true)}
        />
      }
    >
      {accounts.isError && (
        <SectionError>{accounts.error.message}</SectionError>
      )}
      {accounts.data?.length === 0 && (
        <SectionEmpty>No machine accounts yet.</SectionEmpty>
      )}
      {accounts.data?.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          onEdit={() => setEditing(account.id)}
        />
      ))}
      {adding && <AddAccountSheet onClose={() => setAdding(false)} />}
      {edited && (
        <AccountSheet account={edited} onClose={() => setEditing(null)} />
      )}
    </Section>
  );
}

/** Where GitHub sends the owner back: after creating an App or signing in through one with a code, and after installing one without. */
function finishGitHubApp(
  step: GitHubAppStep,
  params: URLSearchParams,
  navigate: UseNavigateResult<string>,
) {
  const installing = sessionStorage.getItem(INSTALLING_KEY);
  const code = params.get("code");
  const state = params.get("state");

  const finish =
    step === "installed"
      ? installing &&
        send<"connectGithubApp">(`${githubAppPath(installing)}/connect`, "POST")
      : code &&
        state &&
        send<"completeGithubApp" | "completeGithubAppSignIn">(
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
    await refreshGithub();
    await navigate({ to: "/settings/coding", replace: true });
  });
}

export function GitHubAppCallback({ step }: { step: GitHubAppStep }) {
  return (
    <RedirectReturn
      finish={(params, navigate) => finishGitHubApp(step, params, navigate)}
      pending="Finishing GitHub setup…"
      backTo="/settings/coding"
      backLabel="Back to Coding"
    />
  );
}

import { useState } from "react";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import {
  IconAdjustmentsHorizontal,
  IconBell,
  IconVolume,
  IconDeviceDesktop,
  IconFingerprint,
  IconHammer,
  IconKey,
  IconLock,
  IconLogin2,
  IconVault,
  IconLogin,
  IconLogout,
  IconPencil,
  IconPlug,
  IconPlus,
  IconSearch,
  IconServer,
  IconSparkles,
  IconTrash,
  IconWorld,
  IconScale,
  IconMessages,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { MarkupLogo } from "@/components/brand-logo";
import { providerLogo } from "./provider-logos";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  type PasswordManager,
  type Provider,
  capabilitiesQuery,
  clearUserData,
  providersQuery,
  queryClient,
  send,
} from "@/lib/api";
import {
  authClient,
  passkeyDone,
  passkeysAvailable,
  useSession,
} from "@/lib/auth-client";
import { unlock } from "cuelume";
import { clearLiveStreams, notifications } from "@/lib/live";
import { CopyButton, EditorSheet } from "@/components/form-fields";
import {
  EMPTY_SOURCE,
  SecretSourceField,
  referenceOf,
  useConnectedPasswordManagers,
  type SecretSourceDraft,
} from "@/components/secret-source-field";
import { LoginDialog, refreshProviders } from "./provider-login";
import {
  MobileSidebarTrigger,
  RowMenu,
  RowTile,
  Section,
  SectionEmpty,
  SettingRow,
  StatusDot,
  WorkspacePage,
} from "@/components/workspace";

const SECTIONS = [
  {
    to: "/settings/general",
    label: "General",
    icon: IconAdjustmentsHorizontal,
  },
  { to: "/settings/providers", label: "Providers", icon: IconKey },
  {
    to: "/settings/password-managers",
    label: "Password managers",
    icon: IconVault,
  },
  { to: "/settings/web-search", label: "Web search", icon: IconWorld },
  { to: "/settings/credentials", label: "Credentials", icon: IconLock },
  { to: "/settings/logins", label: "Logins", icon: IconLogin2 },
  { to: "/settings/judge-model", label: "Judge model", icon: IconScale },
  { to: "/settings/integrations", label: "Integrations", icon: IconPlug },
  {
    to: "/settings/message-gateways",
    label: "Message gateways",
    icon: IconMessages,
  },
  { to: "/settings/skills", label: "Skills", icon: IconSparkles },
] as const;

/** Settings: a section list beside the open section. */
export function SettingsLayout() {
  const matchRoute = useMatchRoute();

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label="Settings"
        className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-52 md:flex-col md:border-r md:border-b-0 md:p-3"
      >
        <MobileSidebarTrigger className="ml-0" />
        <h2 className="hidden px-2 pt-1 pb-2 font-heading font-semibold md:block">
          Settings
        </h2>
        {SECTIONS.map((section) => (
          <Button
            key={section.to}
            variant={matchRoute({ to: section.to }) ? "secondary" : "ghost"}
            className="justify-start"
            render={<Link to={section.to} />}
            nativeButton={false}
          >
            <section.icon data-icon="inline-start" />
            {section.label}
          </Button>
        ))}
      </nav>
      <div
        data-slot="settings-page"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <Outlet />
      </div>
    </div>
  );
}

const PERMISSION = {
  granted: "Replies from chats you don't have open show as notifications.",
  denied: "Blocked for this site in the browser's settings.",
  default: "The browser asks for permission when you turn this on.",
  unsupported: "This browser doesn't support notifications.",
};

function Notifications() {
  const [enabled, setEnabled] = useState(notifications.enabled);
  const [permission, setPermission] = useState(notifications.permission);
  // Unset defaults to enabled, but nothing shows until the browser grants permission.
  const on = enabled && permission === "granted";
  const [sound, setSound] = useState(notifications.sound);

  return (
    <Section title="Notifications">
      <SettingRow
        tile={
          <RowTile>
            <IconBell />
          </RowTile>
        }
        title={<label htmlFor="notifications">Bot replies</label>}
        description={
          enabled || permission !== "granted"
            ? PERMISSION[permission]
            : "Off on this browser."
        }
      >
        <Switch
          id="notifications"
          checked={on}
          disabled={permission === "unsupported"}
          onCheckedChange={async (next) => {
            setEnabled(next);
            await notifications.setEnabled(next);
            setPermission(notifications.permission());
          }}
        />
      </SettingRow>
      <SettingRow
        tile={
          <RowTile>
            <IconVolume />
          </RowTile>
        }
        title={<label htmlFor="notification-sound">Sound</label>}
      >
        <Switch
          id="notification-sound"
          checked={sound}
          disabled={!on}
          onCheckedChange={async (next) => {
            setSound(next);
            notifications.setSound(next);

            if (next) await unlock();
          }}
        />
      </SettingRow>
    </Section>
  );
}

const passkeysQuery = {
  queryKey: ["passkeys"],
  queryFn: async () => {
    const result = await authClient.passkey.listUserPasskeys();

    if (result.error) throw new Error(result.error.message);

    return result.data;
  },
};

type Passkey = NonNullable<
  Awaited<ReturnType<typeof passkeysQuery.queryFn>>
>[number];

const refreshPasskeys = () =>
  queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });

function RenamePasskey({
  passkey,
  onDone,
}: {
  passkey: Passkey;
  onDone: () => void;
}) {
  const [name, setName] = useState(passkey.name ?? "");
  const id = `passkey-${passkey.id}`;

  const rename = useMutation({
    mutationFn: async (next: string) => {
      const result = await authClient.passkey.updatePasskey({
        id: passkey.id,
        name: next,
      });

      if (result.error) throw new Error(result.error.message);
    },
    onSuccess: async () => {
      await refreshPasskeys();
      onDone();
    },
  });

  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault();

        if (name.trim()) rename.mutate(name.trim());
      }}
    >
      <Field data-invalid={rename.isError || undefined}>
        <FieldLabel htmlFor={id} className="sr-only">
          Passkey name
        </FieldLabel>
        <div className="flex gap-2">
          <Input
            id={id}
            autoFocus
            autoComplete="off"
            maxLength={100}
            placeholder="Passkey name"
            aria-invalid={rename.isError || undefined}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={!name.trim() || rename.isPending}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </Field>
      {rename.isError && <FieldError>{rename.error.message}</FieldError>}
    </form>
  );
}

function PasskeyRow({
  passkey,
  removing,
  onRemove,
}: {
  passkey: Passkey;
  removing: boolean;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = useState(false);

  if (renaming)
    return (
      <RenamePasskey passkey={passkey} onDone={() => setRenaming(false)} />
    );

  return (
    <SettingRow
      tile={
        <RowTile>
          <IconFingerprint />
        </RowTile>
      }
      title={<span className="truncate">{passkey.name || "Passkey"}</span>}
      description={
        <>
          Added {new Date(passkey.createdAt).toLocaleDateString()}
          {passkey.backedUp && " · Synced"}
        </>
      }
    >
      <RowMenu>
        <DropdownMenuItem onClick={() => setRenaming(true)}>
          <IconPencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={removing}
          onClick={onRemove}
        >
          <IconTrash />
          Remove
        </DropdownMenuItem>
      </RowMenu>
    </SettingRow>
  );
}

const PASSKEYS_FOOTER = passkeysAvailable ? (
  <>
    Passkeys belong to {location.hostname}. They stop working if the server's
    address changes.
  </>
) : (
  <>
    Adding a passkey needs a secure address with a hostname, not an IP address.
    Open Crumble at localhost, or set CRUMBLE_PUBLIC_URL on the server.
  </>
);

function PasskeyList({
  passkeys,
  removing,
  onRemove,
}: {
  passkeys: UseQueryResult<Passkey[] | null>;
  removing: boolean;
  onRemove: (id: string) => void;
}) {
  if (passkeys.isPending) return <Skeleton className="m-3 h-5 w-40" />;

  if (!passkeys.data?.length)
    return (
      <SectionEmpty>
        Sign in with your device's screen lock or a security key instead of a
        password.
      </SectionEmpty>
    );

  return passkeys.data.map((passkey) => (
    <PasskeyRow
      key={passkey.id}
      passkey={passkey}
      removing={removing}
      onRemove={() => onRemove(passkey.id)}
    />
  ));
}

function Passkeys() {
  const passkeys = useQuery(passkeysQuery);

  const add = useMutation({
    mutationFn: async () => {
      passkeyDone(await authClient.passkey.addPasskey());
    },
    onSettled: refreshPasskeys,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = await authClient.passkey.deletePasskey({ id });

      if (result.error) throw new Error(result.error.message);
    },
    onSettled: refreshPasskeys,
  });

  const error = add.error ?? remove.error ?? passkeys.error;

  // Listing, renaming, and removing need only a session; adding needs WebAuthn.
  return (
    <Section
      title="Passkeys"
      footer={PASSKEYS_FOOTER}
      action={
        passkeysAvailable && (
          <Button
            variant="outline"
            size="sm"
            disabled={add.isPending}
            onClick={() => add.mutate()}
          >
            <IconPlus data-icon="inline-start" />
            Add passkey
          </Button>
        )
      }
    >
      <PasskeyList
        passkeys={passkeys}
        removing={remove.isPending}
        onRemove={(id) => remove.mutate(id)}
      />
      {error && (
        <div className="p-3">
          <FieldError>{error.message}</FieldError>
        </div>
      )}
    </Section>
  );
}

function Account() {
  const session = useSession();
  const user = session.data?.user;

  const signOut = useMutation({
    mutationFn: () => authClient.signOut(),
    onSettled: () => {
      clearLiveStreams();
      clearUserData();
      window.location.assign("/ui/connect");
    },
  });

  const shown = user?.name || user?.email || "Signed in";

  return (
    <Section title="Account">
      <SettingRow
        tile={
          <RowTile className="font-heading text-sm font-semibold text-foreground">
            {shown.slice(0, 1).toUpperCase()}
          </RowTile>
        }
        title={<span className="truncate">{shown}</span>}
        description={user?.name ? user.email : undefined}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          <IconLogout data-icon="inline-start" />
          Sign out
        </Button>
      </SettingRow>
    </Section>
  );
}

function Server() {
  const capabilities = useQuery(capabilitiesQuery);

  const features = [
    {
      name: "Coding jobs",
      icon: IconHammer,
      on: capabilities.data?.coding === true,
      help: "Needs CRUMBLE_WORKSPACE_IMAGE on the server.",
    },
    {
      name: "Desktop jobs",
      icon: IconDeviceDesktop,
      on: capabilities.data?.desktop === true,
      help: "Needs CRUMBLE_WORKSPACE_DESKTOP_IMAGE on the server.",
    },
  ];

  return (
    <Section title="Server">
      <SettingRow
        tile={
          <RowTile>
            <IconServer />
          </RowTile>
        }
        title="Address"
        description={<span className="font-mono">{location.origin}</span>}
      >
        <CopyButton text={location.origin} />
      </SettingRow>
      {features.map((feature) => (
        <SettingRow
          key={feature.name}
          tile={
            <RowTile>
              <feature.icon />
            </RowTile>
          }
          title={feature.name}
          description={
            capabilities.isSuccess && !feature.on ? (
              <span className="font-mono text-xs">{feature.help}</span>
            ) : undefined
          }
        >
          {capabilities.isPending ? (
            <Skeleton className="h-5 w-16" />
          ) : (
            <StatusDot
              on={feature.on}
              label={feature.on ? "Available" : "Off"}
            />
          )}
        </SettingRow>
      ))}
      {capabilities.isError && (
        <div className="p-3">
          <FieldError>{capabilities.error.message}</FieldError>
        </div>
      )}
    </Section>
  );
}

export function GeneralSettings() {
  return (
    <WorkspacePage title="General">
      <Account />
      <Notifications />
      <Passkeys />
      <Server />
    </WorkspacePage>
  );
}

const EXTERNAL_STATUS = {
  signed_in: "Signed in",
  signed_out: "Not signed in",
  cli_missing: "Not installed",
  unsupported_version: "Unsupported version",
  error: "Unavailable",
} as const;

function keyStatus(provider: Provider, managers: PasswordManager[]) {
  if (!provider.passwordManager) return "Key saved";

  const manager = managers.find((item) => item.id === provider.passwordManager);

  return `Key in ${manager?.name ?? "a password manager"}`;
}

function status(provider: Provider, managers: PasswordManager[]) {
  if (provider.externalAuth)
    return EXTERNAL_STATUS[provider.externalAuth.status];

  if (provider.credentialType === "oauth") return "Signed in";

  if (provider.credentialType === "api_key")
    return keyStatus(provider, managers);

  if (provider.configured) return "From environment";

  return provider.activeLoginId ? "Signing in…" : null;
}

/** The key to save, or null to remove the saved credential. */
const providerKeyBody = (source: SecretSourceDraft) => {
  const reference = referenceOf(source);

  if (reference) return { reference };

  return source.kind === "value" && source.value.trim()
    ? { apiKey: source.value.trim() }
    : null;
};

function useProviderCredential(provider: Provider) {
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState<SecretSourceDraft>(EMPTY_SOURCE);
  const path = `/v1/providers/${encodeURIComponent(provider.provider)}`;

  // `refreshProviders` invalidates the provider and model queries.
  // react-doctor-disable-next-line query-mutation-missing-invalidation
  const save = useMutation({
    mutationFn: (body: ReturnType<typeof providerKeyBody>) =>
      body === null ? send(path, "DELETE") : send(path, "PUT", body),
    onSuccess: async () => {
      setSource(EMPTY_SOURCE);
      setEditing(false);
      await refreshProviders();
      // Drop the submitted key from the mutation state.
      save.reset();
    },
  });

  return { editing, setEditing, source, setSource, save };
}

type ProviderCredential = ReturnType<typeof useProviderCredential>;

/** Set-up providers keep their actions in the row menu; others show how to set them up. */
function providerSignInAvailable(provider: Provider) {
  return (
    provider.authMethods.some((method) => method.type === "oauth") &&
    provider.credentialType !== "oauth"
  );
}

function providerKeyAvailable(provider: Provider, editing: boolean) {
  return (
    !editing && provider.authMethods.some((method) => method.type === "api_key")
  );
}

function ProviderTile({ provider }: { provider: Provider }) {
  const logo = providerLogo(provider.provider);

  return logo ? (
    <RowTile className="text-foreground">
      <MarkupLogo svg={logo} />
    </RowTile>
  ) : (
    <RowTile className="font-heading text-sm font-semibold text-foreground">
      {provider.name.slice(0, 1).toUpperCase()}
    </RowTile>
  );
}

function ProviderActions({
  provider,
  credential,
  onSignIn,
}: {
  provider: Provider;
  credential: ProviderCredential;
  onSignIn: () => void;
}) {
  const { editing, setEditing, save } = credential;

  const signIn = providerSignInAvailable(provider);

  const addKey = providerKeyAvailable(provider, editing);

  const signInLabel = provider.activeLoginId ? "Continue sign-in" : "Sign in";

  if (!provider.credentialType)
    return (
      <>
        {addKey && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Add key
          </Button>
        )}
        {signIn && (
          <Button variant="outline" size="sm" onClick={onSignIn}>
            {signInLabel}
          </Button>
        )}
      </>
    );

  return (
    <RowMenu>
      {signIn && (
        <DropdownMenuItem onClick={onSignIn}>
          <IconLogin />
          {signInLabel}
        </DropdownMenuItem>
      )}
      {addKey && (
        <DropdownMenuItem onClick={() => setEditing(true)}>
          <IconKey />
          {provider.credentialType === "api_key" ? "Replace key" : "Use a key"}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        variant="destructive"
        disabled={save.isPending}
        onClick={() => save.mutate(null)}
      >
        <IconTrash />
        {provider.credentialType === "oauth" ? "Sign out" : "Remove key"}
      </DropdownMenuItem>
    </RowMenu>
  );
}

function ProviderRow({
  provider,
  onSignIn,
}: {
  provider: Provider;
  onSignIn: () => void;
}) {
  const credential = useProviderCredential(provider);
  const oauth = provider.authMethods.find((method) => method.type === "oauth");
  const managers = useConnectedPasswordManagers();
  const label = status(provider, managers);

  return (
    <div className="flex flex-col">
      <SettingRow
        tile={<ProviderTile provider={provider} />}
        title={
          <>
            <span className="truncate">{provider.name}</span>
            {label && (
              <span className="font-normal">
                <StatusDot on={provider.configured} label={label} />
              </span>
            )}
          </>
        }
        description={oauth?.label}
      >
        <ProviderActions
          provider={provider}
          credential={credential}
          onSignIn={onSignIn}
        />
      </SettingRow>
      {credential.editing && (
        <ProviderKeySheet
          provider={provider}
          credential={credential}
          managers={managers}
        />
      )}
      <ProviderNotes provider={provider} credential={credential} />
    </div>
  );
}

/** A failed save outside the key sheet, and how to sign in outside Crumble. */
function ProviderNotes({
  provider,
  credential,
}: {
  provider: Provider;
  credential: ProviderCredential;
}) {
  const failed = credential.save.isError && !credential.editing;

  if (!failed && !provider.externalAuth) return null;

  return (
    <div className="flex flex-col gap-2 px-3 pb-3 pl-14">
      {failed && <FieldError>{credential.save.error?.message}</FieldError>}
      {provider.externalAuth && (
        <ExternalSignIn external={provider.externalAuth} />
      )}
    </div>
  );
}

/** The provider's API key, typed in or read from a connected password manager. */
function ProviderKeySheet({
  provider,
  credential,
  managers,
}: {
  provider: Provider;
  credential: ProviderCredential;
  managers: PasswordManager[];
}) {
  const body = providerKeyBody(credential.source);

  return (
    <EditorSheet
      title={`${provider.credentialType === "api_key" ? "Replace" : "Add"} ${provider.name} API key`}
      error={credential.save.error?.message}
      submitLabel="Save"
      submitDisabled={!body || credential.save.isPending}
      onSubmit={() => body && credential.save.mutate(body)}
      onClose={() => {
        credential.setEditing(false);
        credential.setSource(EMPTY_SOURCE);
        credential.save.reset();
      }}
    >
      <SecretSourceField
        id={`provider-key-${provider.provider}`}
        label="API key"
        value={credential.source}
        onChange={credential.setSource}
        connected={managers}
        valuePlaceholder="API key"
        valueDescription="Stored encrypted and never shown again."
      />
    </EditorSheet>
  );
}

/** A provider that signs in outside Crumble: why it is not ready, and the command to run on the server. */
function ExternalSignIn({
  external,
}: {
  external: NonNullable<Provider["externalAuth"]>;
}) {
  const signedIn = external.status === "signed_in";
  const command = signedIn ? external.signOutCommand : external.signInCommand;

  return (
    <div className="flex flex-col gap-2 text-sm text-muted-foreground">
      {external.message && <p>{external.message}</p>}
      {external.status === "unsupported_version" && (
        <p>
          Installed {external.cliVersion ?? "unknown"}; supported{" "}
          {external.qualifiedVersions.join(", ")}.
        </p>
      )}
      {command && external.status !== "cli_missing" && (
        <div className="flex flex-col gap-1">
          <span>
            {signedIn
              ? "To sign out, run on the server:"
              : "To sign in, run on the server:"}
          </span>
          <div className="flex items-center gap-1 rounded-lg border bg-background py-1 pr-1 pl-3">
            <code className="flex-1 font-mono text-xs break-all text-foreground">
              {command}
            </code>
            <CopyButton text={command} />
          </div>
        </div>
      )}
    </div>
  );
}

function matching(providers: Provider[], needle: string) {
  return providers
    .filter(
      (provider) =>
        !needle ||
        provider.name.toLowerCase().includes(needle) ||
        provider.provider.includes(needle),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

function ProviderSection({
  title,
  description,
  providers,
  onSignIn,
}: {
  title: string;
  description?: string;
  providers: Provider[];
  onSignIn: (provider: Provider) => void;
}) {
  if (!providers.length) return null;

  return (
    <Section title={title} description={description}>
      {providers.map((provider) => (
        <ProviderRow
          key={provider.provider}
          provider={provider}
          onSignIn={() => onSignIn(provider)}
        />
      ))}
    </Section>
  );
}

/** Every provider once, set-up ones first: sign in with an account, add a key, or remove either. */
export function ProvidersSettings() {
  const providers = useQuery(providersQuery);
  const [search, setSearch] = useState("");
  const [signingIn, setSigningIn] = useState<Provider | null>(null);
  const shown = matching(providers.data ?? [], search.trim().toLowerCase());
  const ready = shown.filter((provider) => provider.configured);

  return (
    <WorkspacePage
      title="Providers"
      onRefresh={() => void providers.refetch()}
      refreshing={providers.isFetching}
    >
      <div className="relative">
        <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Search providers"
          placeholder="Search providers"
          className="pl-8"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {providers.isPending && <Skeleton className="h-40 rounded-xl" />}
      {providers.isError && <FieldError>{providers.error.message}</FieldError>}
      {providers.isSuccess && shown.length === 0 && (
        <Empty className="rounded-xl border">
          <EmptyHeader>
            <EmptyTitle>No providers match</EmptyTitle>
            <EmptyDescription>Try another name.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <ProviderSection
        title="Set up"
        description="Bots use these providers' models. Keys and sign-ins are stored encrypted on the server and shared by every bot."
        providers={ready}
        onSignIn={setSigningIn}
      />
      <ProviderSection
        title={ready.length ? "Available" : "Providers"}
        providers={shown.filter((provider) => !provider.configured)}
        onSignIn={setSigningIn}
      />
      {signingIn && (
        <LoginDialog
          key={signingIn.provider}
          provider={signingIn}
          onClose={() => setSigningIn(null)}
        />
      )}
    </WorkspacePage>
  );
}

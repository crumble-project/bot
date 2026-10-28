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
  IconDeviceDesktop,
  IconFingerprint,
  IconHammer,
  IconKey,
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
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
import { clearLiveStreams, notifications } from "@/lib/live";
import { CopyButton, SecretForm } from "@/components/form-fields";
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
  { to: "/settings/web-search", label: "Web search", icon: IconWorld },
  { to: "/settings/integrations", label: "Integrations", icon: IconPlug },
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
  const [on, setOn] = useState(notifications.enabled);
  const [permission, setPermission] = useState(notifications.permission);

  return (
    <Section title="Notifications">
      <SettingRow
        tile={
          <RowTile>
            <IconBell />
          </RowTile>
        }
        title={<label htmlFor="notifications">Bot replies</label>}
        description={on ? PERMISSION[permission] : "Off on this browser."}
      >
        <Switch
          id="notifications"
          checked={on}
          disabled={permission === "unsupported"}
          onCheckedChange={async (next) => {
            setOn(next);
            await notifications.setEnabled(next);
            setPermission(notifications.permission());
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

function status(provider: Provider) {
  if (provider.externalAuth)
    return EXTERNAL_STATUS[provider.externalAuth.status];

  if (provider.credentialType === "oauth") return "Signed in";

  if (provider.credentialType === "api_key") return "Key saved";

  if (provider.configured) return "From environment";

  return provider.activeLoginId ? "Signing in…" : null;
}

function useProviderCredential(provider: Provider) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const path = `/v1/providers/${encodeURIComponent(provider.provider)}`;

  const save = useMutation({
    mutationFn: (apiKey: string | null) =>
      apiKey === null ? send(path, "DELETE") : send(path, "PUT", { apiKey }),
    onSuccess: async () => {
      setKey("");
      setEditing(false);
      await refreshProviders();
      // Drop the submitted key from the mutation state.
      save.reset();
    },
  });

  return { editing, setEditing, key, setKey, save };
}

type ProviderCredential = ReturnType<typeof useProviderCredential>;

/** Set-up providers keep their actions in the row menu; others show how to set them up. */
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

  const signIn =
    provider.authMethods.some((method) => method.type === "oauth") &&
    provider.credentialType !== "oauth";

  const addKey =
    !editing &&
    provider.authMethods.some((method) => method.type === "api_key");

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
  const label = status(provider);

  return (
    <div className="flex flex-col">
      <SettingRow
        tile={
          <RowTile className="font-heading text-sm font-semibold text-foreground">
            {provider.name.slice(0, 1).toUpperCase()}
          </RowTile>
        }
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
      {(credential.editing ||
        credential.save.isError ||
        provider.externalAuth) && (
        <div className="flex flex-col gap-2 px-3 pb-3 pl-14">
          {credential.editing && (
            <SecretForm
              label={`${provider.name} API key`}
              value={credential.key}
              pending={credential.save.isPending}
              onChange={credential.setKey}
              onSave={() => credential.save.mutate(credential.key.trim())}
              onCancel={() => {
                credential.setEditing(false);
                credential.setKey("");
              }}
            />
          )}
          {credential.save.isError && (
            <FieldError>{credential.save.error.message}</FieldError>
          )}
          {provider.externalAuth && (
            <ExternalSignIn external={provider.externalAuth} />
          )}
        </div>
      )}
    </div>
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

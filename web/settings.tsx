import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  Key01Icon,
  Plug01Icon,
  Search01Icon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  type Provider,
  capabilitiesQuery,
  providersQuery,
  send,
  token,
} from "./api";
import { notifications } from "./live";
import { LoginDialog, refreshProviders } from "./provider-login";
import { Section, WorkspacePage } from "./workspace";

const SECTIONS = [
  { to: "/settings/general", label: "General", icon: SlidersHorizontalIcon },
  { to: "/settings/providers", label: "Providers", icon: Key01Icon },
  { to: "/settings/integrations", label: "Integrations", icon: Plug01Icon },
  { to: "/settings/skills", label: "Skills", icon: SparklesIcon },
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
            <HugeiconsIcon icon={section.icon} data-icon="inline-start" />
            {section.label}
          </Button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}

const PERMISSION = {
  granted: "Bot replies show as browser notifications.",
  denied: "Notifications are blocked for this site in the browser's settings.",
  default: "The browser asks for permission when you turn this on.",
  unsupported: "This browser doesn't support notifications.",
};

function Notifications() {
  const [on, setOn] = useState(notifications.enabled);
  const [permission, setPermission] = useState(notifications.permission);

  return (
    <Field orientation="horizontal" className="p-3">
      <FieldContent>
        <FieldLabel htmlFor="notifications">Notifications</FieldLabel>
        <FieldDescription>
          {on ? PERMISSION[permission] : "Notifications are off."} Only replies
          from chats that aren't open notify.
        </FieldDescription>
      </FieldContent>
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
    </Field>
  );
}

export function GeneralSettings() {
  const capabilities = useQuery(capabilitiesQuery);

  const features = [
    {
      name: "Coding jobs",
      on: capabilities.data?.coding,
      help: "Needs CRUMBLE_WORKSPACE_IMAGE on the server.",
    },
    {
      name: "Desktop jobs",
      on: capabilities.data?.desktop,
      help: "Needs CRUMBLE_WORKSPACE_DESKTOP_IMAGE on the server.",
    },
  ];

  return (
    <WorkspacePage title="General">
      <Section title="This browser">
        <Notifications />
        <Field orientation="horizontal" className="p-3">
          <FieldContent>
            <FieldLabel>Sign out</FieldLabel>
            <FieldDescription>
              Forgets the server token in this browser. Other clients stay
              connected.
            </FieldDescription>
          </FieldContent>
          <Button variant="outline" size="sm" onClick={() => token.set(null)}>
            Sign out
          </Button>
        </Field>
      </Section>
      <Section title="Server">
        <Field orientation="horizontal" className="p-3">
          <FieldContent>
            <FieldLabel>Address</FieldLabel>
            <FieldDescription>{location.origin}</FieldDescription>
          </FieldContent>
        </Field>
        {features.map((feature) => (
          <Field key={feature.name} orientation="horizontal" className="p-3">
            <FieldContent>
              <FieldLabel>{feature.name}</FieldLabel>
              <FieldDescription>{feature.help}</FieldDescription>
            </FieldContent>
            {capabilities.isPending ? (
              <Skeleton className="h-5 w-16" />
            ) : (
              <Badge variant={feature.on ? "secondary" : "outline"}>
                {feature.on ? "Available" : "Off"}
              </Badge>
            )}
          </Field>
        ))}
      </Section>
      {capabilities.isError && (
        <FieldError>{capabilities.error.message}</FieldError>
      )}
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

function ProviderRow({
  provider,
  onSignIn,
}: {
  provider: Provider;
  onSignIn: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const path = `/v1/providers/${encodeURIComponent(provider.provider)}`;
  const oauth = provider.authMethods.find((method) => method.type === "oauth");

  const takesKey = provider.authMethods.some(
    (method) => method.type === "api_key",
  );

  const label = status(provider);
  const id = `key-${provider.provider}`;

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

  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 font-medium">
            {provider.name}
            {label && (
              <Badge variant={provider.configured ? "secondary" : "outline"}>
                {label}
              </Badge>
            )}
          </span>
          {oauth && (
            <span className="truncate text-sm text-muted-foreground">
              {oauth.label}
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {oauth && provider.credentialType !== "oauth" && (
            <Button variant="outline" size="sm" onClick={onSignIn}>
              {provider.activeLoginId ? "Continue sign-in" : "Sign in"}
            </Button>
          )}
          {takesKey && !editing && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {provider.credentialType === "api_key"
                ? "Replace key"
                : "Add key"}
            </Button>
          )}
          {provider.credentialType && (
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate(null)}
            >
              {provider.credentialType === "oauth" ? "Sign out" : "Remove key"}
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();

            if (key.trim()) save.mutate(key.trim());
          }}
        >
          <Field data-invalid={save.isError || undefined}>
            <FieldLabel htmlFor={id} className="sr-only">
              {provider.name} API key
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                id={id}
                type="password"
                autoFocus
                autoComplete="off"
                placeholder="API key"
                aria-invalid={save.isError || undefined}
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
              <Button type="submit" disabled={!key.trim() || save.isPending}>
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setKey("");
                }}
              >
                Cancel
              </Button>
            </div>
          </Field>
        </form>
      )}
      {save.isError && <FieldError>{save.error.message}</FieldError>}
      {provider.externalAuth && (
        <ExternalSignIn external={provider.externalAuth} />
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
          <div className="flex items-start gap-1">
            <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-all">
              {command}
            </code>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Copy"
              onClick={() => void navigator.clipboard.writeText(command)}
            >
              <HugeiconsIcon icon={Copy01Icon} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Every provider once, set-up ones first: sign in with an account, add a key, or remove either. */
export function ProvidersSettings() {
  const providers = useQuery(providersQuery);
  const [search, setSearch] = useState("");
  const [signingIn, setSigningIn] = useState<Provider | null>(null);
  const needle = search.trim().toLowerCase();

  const shown = (providers.data ?? [])
    .filter(
      (provider) =>
        !needle ||
        provider.name.toLowerCase().includes(needle) ||
        provider.provider.includes(needle),
    )
    .sort(
      (a, b) =>
        Number(b.configured) - Number(a.configured) ||
        a.name.localeCompare(b.name),
    );

  const ready = shown.filter((provider) => provider.configured);
  const others = shown.filter((provider) => !provider.configured);

  const list = (title: string, group: Provider[]) =>
    group.length > 0 && (
      <section className="flex flex-col">
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
        {group.map((provider, index) => (
          <div key={provider.provider}>
            {index > 0 && <Separator />}
            <ProviderRow
              provider={provider}
              onSignIn={() => setSigningIn(provider)}
            />
          </div>
        ))}
      </section>
    );

  return (
    <WorkspacePage
      title="Providers"
      onRefresh={() => void providers.refetch()}
      refreshing={providers.isFetching}
    >
      <p className="text-sm text-muted-foreground">
        Bots use these providers' models. Keys and account sign-ins are stored
        encrypted on the server, are never shown again, and are shared by every
        bot on the provider.
      </p>
      <div className="relative">
        <HugeiconsIcon
          icon={Search01Icon}
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search providers"
          placeholder="Search providers"
          className="pl-8"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {providers.isPending && <Skeleton className="h-40" />}
      {providers.isError && <FieldError>{providers.error.message}</FieldError>}
      {providers.isSuccess && shown.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No providers match</EmptyTitle>
            <EmptyDescription>Try another name.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {list("Set up", ready)}
      {list(ready.length ? "Available" : "Providers", others)}
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

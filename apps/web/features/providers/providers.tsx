import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  IconCheck,
  IconCopy,
  IconKey,
  IconLogin,
  IconTrash,
} from "@tabler/icons-react";
import { MarkupLogo } from "@/components/brand-logo";
import { EditorSheet } from "@/components/form-fields";
import {
  SecretSourceField,
  type SecretInput,
  useConnectedPasswordManagers,
  useSecretDraft,
} from "@/features/password-managers/secret-source-field";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldError } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RowMenu,
  RowTile,
  Section,
  SettingRow,
  StatusDot,
  Page,
  PageToolbar,
} from "@/components/page";
import { send } from "@/lib/api";
import {
  type PasswordManager,
  invalidateSecrets,
} from "@/features/password-managers/api";
import {
  type Provider,
  providersQuery,
  providerPath,
  invalidateProviders,
} from "./api";
import { SignInDialog } from "./provider-sign-in";
import { providerLogo } from "./provider-logos";

const EXTERNAL_STATUS = {
  signed_in: "Signed in",
  signed_out: "Not signed in",
  cli_missing: "Not installed",
  error: "Unavailable",
} as const;

function keyStatus(provider: Provider, managers: PasswordManager[]) {
  if (!provider.apiKey.passwordManager) return "Key saved";

  const manager = managers.find(
    (item) => item.id === provider.apiKey.passwordManager,
  );

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

function useProviderCredential(provider: Provider) {
  const [editing, setEditing] = useState(false);
  const path = providerPath(provider.provider);

  // `invalidateProviders` invalidates the provider and model queries.
  // react-doctor-disable-next-line query-mutation-missing-invalidation
  const save = useMutation({
    mutationFn: (body: SecretInput | null) =>
      body === null
        ? send<"deleteProvider">(path, "DELETE")
        : send<"putProvider">(path, "PUT", body),
    onSuccess: async () => {
      setEditing(false);
      await Promise.all([invalidateProviders(), invalidateSecrets()]);
      // Drop the submitted key from the mutation state.
      save.reset();
    },
  });

  return { editing, setEditing, save };
}

type ProviderCredential = ReturnType<typeof useProviderCredential>;

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
        {provider.externalAuth ? (
          <ExternalActions external={provider.externalAuth} />
        ) : (
          <ProviderActions
            provider={provider}
            credential={credential}
            onSignIn={onSignIn}
          />
        )}
      </SettingRow>
      {credential.editing && (
        <ProviderKeySheet provider={provider} credential={credential} />
      )}
      <ProviderNotes provider={provider} credential={credential} />
    </div>
  );
}

function externalProblem(provider: Provider) {
  const status = provider.externalAuth?.status;

  return status === "cli_missing" || status === "error"
    ? provider.externalAuth?.message
    : undefined;
}

function ProviderNotes({
  provider,
  credential,
}: {
  provider: Provider;
  credential: ProviderCredential;
}) {
  const failed = credential.save.isError && !credential.editing;

  const problem = externalProblem(provider);

  if (!failed && !problem) return null;

  return (
    <div className="flex flex-col gap-2 px-3 pb-3 pl-14">
      {failed && <FieldError>{credential.save.error?.message}</FieldError>}
      {problem && <p className="text-sm text-muted-foreground">{problem}</p>}
    </div>
  );
}

function ProviderKeySheet({
  provider,
  credential,
}: {
  provider: Provider;
  credential: ProviderCredential;
}) {
  const key = useSecretDraft(provider.apiKey);

  return (
    <EditorSheet
      title={`${provider.credentialType === "api_key" ? "Replace" : "Add"} ${provider.name} API key`}
      error={credential.save.error?.message}
      submitLabel="Save"
      submitDisabled={!key.changed || credential.save.isPending}
      onSubmit={() => key.input && credential.save.mutate(key.input)}
      onClose={() => {
        credential.setEditing(false);
        credential.save.reset();
      }}
    >
      <SecretSourceField
        id={`provider-key-${provider.provider}`}
        label="API key"
        {...key.field}
        valuePlaceholder="API key"
      />
    </EditorSheet>
  );
}

function ExternalActions({
  external,
}: {
  external: NonNullable<Provider["externalAuth"]>;
}) {
  const signedIn = external.status === "signed_in";
  const command = signedIn ? external.signOutCommand : external.signInCommand;

  if (!command || external.status === "cli_missing") return null;

  return (
    <RowMenu>
      <CopyCommandItem
        command={command}
        label={signedIn ? "Copy sign-out command" : "Copy sign-in command"}
      />
    </RowMenu>
  );
}

function CopyCommandItem({
  command,
  label,
}: {
  command: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <DropdownMenuItem
      closeOnClick={false}
      title={command}
      onClick={() =>
        void navigator.clipboard.writeText(command).then(() => setCopied(true))
      }
    >
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? "Copied" : label}
    </DropdownMenuItem>
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

export function ProvidersSettings() {
  const providers = useQuery(providersQuery);
  const [search, setSearch] = useState("");
  const [signingIn, setSigningIn] = useState<Provider | null>(null);
  const shown = matching(providers.data ?? [], search.trim().toLowerCase());
  const ready = shown.filter((provider) => provider.configured);

  return (
    <Page
      title="Providers"
      onRefresh={() => void providers.refetch()}
      refreshing={providers.isFetching}
    >
      <PageToolbar
        search={search}
        searchLabel="Search providers"
        onSearch={setSearch}
      />
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
        <SignInDialog
          key={signingIn.provider}
          provider={signingIn}
          onClose={() => setSigningIn(null)}
        />
      )}
    </Page>
  );
}

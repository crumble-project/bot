import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { IconHistory } from "@tabler/icons-react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SecretSourceField,
  referenceOf,
  sourceDraftOf,
  useConnectedPasswordManagers,
  type SecretSourceDraft,
} from "@/components/secret-source-field";
import {
  type Bot,
  type Credential,
  type CredentialRequest,
  type Credentials,
  type CredentialUse,
  type PasswordManagerId,
  call,
  credentialPath,
  credentialsQuery,
  queryClient,
} from "@/lib/api";
import { NewButton, PageToolbar, WorkspacePage } from "@/components/workspace";
import {
  ALL,
  ActionFailure,
  BotPills,
  DeleteSecretDialog,
  LastUse,
  SecretSheet,
  defaultOwner,
  SecretGroups,
  SecretRowMenu,
  SecretRowName,
  UsesDialog,
  hostList,
  useBotQueries,
  useSecretActions,
  type BotEntry,
  type Target,
} from "@/components/bot-secrets";

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** What the dialog edits: a credential, a request to answer, or a new credential. */
type Editing =
  | { kind: "credential"; credential: Credential }
  | { kind: "request"; request: CredentialRequest }
  | { kind: "new" };

const invalidate = (botId: string) =>
  queryClient.invalidateQueries({ queryKey: credentialsQuery(botId).queryKey });

const credentialsOf = (data: Credentials) => data.credentials;

const requestsOf = (data: Credentials) => data.requests;

const countOf = (entry: BotEntry<Credentials>) =>
  (entry.query.data?.credentials.length ?? 0) +
  (entry.query.data?.requests.length ?? 0);

function CredentialRow({
  credential,
  onEdit,
  onUses,
  onDelete,
}: {
  credential: Credential;
  onEdit: () => void;
  onUses: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/50">
      <SecretRowName
        name={credential.name}
        hosts={credential.hosts}
        mono
        onEdit={onEdit}
      />
      <LastUse
        lastUsedAt={credential.lastUsedAt}
        lastError={credential.lastError}
        used="Used"
        never="Never used"
      />
      <SecretRowMenu
        uses={
          <>
            <IconHistory />
            Uses
          </>
        }
        onUses={onUses}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

function CredentialUsesDialog({
  target,
  onClose,
}: {
  target: Target<Credential>;
  onClose: () => void;
}) {
  const { botId, item } = target;

  return (
    <UsesDialog<CredentialUse>
      title={`Uses of ${item.name}`}
      description="Requests sent with the value in the last 90 days, newest first."
      empty="Not used yet."
      queryKey={["credential-uses", botId, item.name]}
      path={`${credentialPath(botId, item.name)}/uses`}
      onClose={onClose}
    >
      {(use) => (
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {use.method} {use.host}
            {use.path}
          </span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {use.status ?? "failed"}
          </span>
        </>
      )}
    </UsesDialog>
  );
}

/** Every bot's credentials and requests, with values the owner enters but never sees again. */
export function CredentialsSettings({
  initialBot,
}: {
  initialBot?: string | undefined;
}) {
  const { bots, entries, refreshing } = useBotQueries(credentialsQuery);
  const [scope, setScope] = useState(initialBot ?? ALL);
  const [search, setSearch] = useState("");

  const [editing, setEditing] = useState<{
    botId: string | null;
    editing: Editing;
  } | null>(null);

  const actions = useSecretActions<Credential>(credentialPath, invalidate);

  return (
    <WorkspacePage
      title="Credentials"
      refreshing={refreshing}
      onRefresh={() =>
        void Promise.all(entries.map((entry) => invalidate(entry.bot.id)))
      }
    >
      <div className="flex flex-col gap-3">
        <PageToolbar
          search={search}
          searchLabel="Search credentials"
          onSearch={setSearch}
        >
          <NewButton
            label="New credential"
            disabled={!bots.data?.length}
            onClick={() =>
              setEditing({
                botId: scope === ALL ? null : scope,
                editing: { kind: "new" },
              })
            }
          />
        </PageToolbar>
        <BotPills
          label="Whose credentials"
          entries={entries}
          scope={scope}
          onScope={setScope}
          countOf={countOf}
        />
      </div>
      <ActionFailure actions={actions} />
      {bots.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <SecretGroups
          entries={entries}
          scope={scope}
          needle={search.trim().toLowerCase()}
          itemsOf={credentialsOf}
          requestsOf={requestsOf}
          onAdd={(botId, request) =>
            setEditing({ botId, editing: { kind: "request", request } })
          }
          onDecline={(botId, name) =>
            actions.decline.mutate({ botId, item: name })
          }
          empty="None yet. The bot asks for one when a coding job needs it."
          noMatch="No credentials match your search."
          note="Coding jobs get a placeholder for each credential; the value only goes to its hosts. Uses are kept for 90 days."
        >
          {(botId, credential) => (
            <CredentialRow
              key={credential.name}
              credential={credential}
              onEdit={() =>
                setEditing({
                  botId,
                  editing: { kind: "credential", credential },
                })
              }
              onUses={() => actions.setUses({ botId, item: credential })}
              onDelete={() =>
                actions.setDeleting({ botId, item: credential.name })
              }
            />
          )}
        </SecretGroups>
      )}
      {editing && (
        <CredentialDialog
          bots={bots.data ?? []}
          botId={editing.botId}
          editing={editing.editing}
          onClose={() => setEditing(null)}
        />
      )}
      {actions.uses && (
        <CredentialUsesDialog
          target={actions.uses}
          onClose={() => actions.setUses(null)}
        />
      )}
      <DeleteSecretDialog
        actions={actions}
        description="Requests with its placeholder stop working at once, and its uses are deleted. This cannot be undone."
      />
    </WorkspacePage>
  );
}

type CredentialBody = {
  hosts: string[];
  value?: string;
  reference?: { passwordManager: PasswordManagerId; reference: string };
};

/** The draft's reference, unless it is the one already saved. */
function changedReference(
  source: SecretSourceDraft,
  existing: Credential | null,
) {
  const reference = referenceOf(source);

  if (!reference || !existing) return reference;

  return reference.passwordManager === existing.passwordManager &&
    reference.reference === existing.reference
    ? null
    : reference;
}

/** Sends the source only when it changes: a typed value, or a reference other than the saved one. */
function credentialBody(
  draft: { hosts: string; source: SecretSourceDraft },
  existing: Credential | null,
): CredentialBody {
  const reference = changedReference(draft.source, existing);

  return {
    hosts: hostList(draft.hosts),
    ...(draft.source.kind === "value" &&
      draft.source.value && { value: draft.source.value }),
    ...(reference && { reference }),
  };
}

function useSaveCredential(
  botId: string,
  draft: { name: string; hosts: string; source: SecretSourceDraft },
  existing: Credential | null,
  onClose: () => void,
) {
  return useMutation({
    mutationFn: () =>
      call<Credential, CredentialBody>(
        credentialPath(botId, draft.name),
        "PUT",
        credentialBody(draft, existing),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: credentialsQuery(botId).queryKey,
      });
      onClose();
    },
  });
}

const savedSource = (existing: Credential | null) =>
  sourceDraftOf(existing?.passwordManager, existing?.reference);

function credentialDraft(editing: Editing, botId: string | null, bots: Bot[]) {
  const existing = editing.kind === "credential" ? editing.credential : null;
  const request = editing.kind === "request" ? editing.request : null;
  const source = existing ?? request;

  return {
    existing,
    request,
    owner: defaultOwner(botId, bots),
    name: source?.name ?? "",
    hosts: (source?.hosts ?? []).join(", "),
    source: savedSource(existing),
  };
}

function credentialReady(
  name: string,
  hosts: string,
  source: SecretSourceDraft,
  existing: Credential | null,
  pending: boolean,
) {
  const hasSource =
    source.kind === "value"
      ? source.value !== ""
      : referenceOf(source) !== null;

  return (
    NAME.test(name) &&
    hostList(hosts).length > 0 &&
    (existing !== null || hasSource) &&
    !pending
  );
}

function CredentialDialog({
  bots,
  botId,
  editing,
  onClose,
}: {
  bots: Bot[];
  /** Null for a new credential from all bots: the sheet asks which bot it is for. */
  botId: string | null;
  editing: Editing;
  onClose: () => void;
}) {
  const { existing, request, ...initial } = credentialDraft(
    editing,
    botId,
    bots,
  );

  const [owner, setOwner] = useState(initial.owner);
  const [name, setName] = useState(initial.name);
  const [hosts, setHosts] = useState(initial.hosts);
  const [source, setSource] = useState(initial.source);

  const connected = useConnectedPasswordManagers();

  const save = useSaveCredential(
    owner,
    { name, hosts, source },
    existing,
    onClose,
  );

  const ready = credentialReady(name, hosts, source, existing, save.isPending);

  return (
    <SecretSheet
      noun="Credential"
      existing={existing?.name ?? null}
      reason={request?.reason}
      error={save.error?.message}
      ready={ready}
      bots={bots}
      botId={botId}
      owner={owner}
      onOwner={setOwner}
      onSubmit={() => save.mutate()}
      onClose={onClose}
    >
      <CredentialFields
        locked={editing.kind !== "new"}
        proposed={request !== null}
        draft={{ name, hosts }}
        onName={setName}
        onHosts={setHosts}
      />
      <SecretSourceField
        id="credential-value"
        label="Value"
        value={source}
        onChange={setSource}
        connected={connected}
        valuePlaceholder={
          existing?.passwordManager === null
            ? "Keep the saved value"
            : undefined
        }
        valueDescription="Stored encrypted and never shown again."
      />
    </SecretSheet>
  );
}

function CredentialFields({
  locked,
  proposed,
  draft,
  onName,
  onHosts,
}: {
  locked: boolean;
  proposed: boolean;
  draft: { name: string; hosts: string };
  onName: (name: string) => void;
  onHosts: (hosts: string) => void;
}) {
  const nameInvalid = draft.name !== "" && !NAME.test(draft.name);

  return (
    <>
      <Field data-invalid={nameInvalid || undefined}>
        <FieldLabel htmlFor="credential-name">Name</FieldLabel>
        <Input
          id="credential-name"
          placeholder="ACME_TOKEN"
          autoComplete="off"
          disabled={locked}
          aria-invalid={nameInvalid || undefined}
          value={draft.name}
          onChange={(event) => onName(event.target.value.toUpperCase())}
        />
        <FieldDescription>
          The environment variable coding jobs see.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="credential-hosts">Hosts</FieldLabel>
        <Input
          id="credential-hosts"
          placeholder="api.example.com, *.example.com"
          autoComplete="off"
          value={draft.hosts}
          onChange={(event) => onHosts(event.target.value)}
        />
        <FieldDescription>
          {proposed
            ? "The bot proposed these. The value goes only to them, so check they belong to the service."
            : "The value goes only to these hosts. *.example.com covers every subdomain."}
        </FieldDescription>
      </Field>
    </>
  );
}

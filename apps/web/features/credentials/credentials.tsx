import { IconHistory } from "@tabler/icons-react";
import {
  type Credential,
  type Credentials,
  type CredentialUse,
  credentialPath,
  credentialsQuery,
  refreshCredentials,
} from "./api";
import { CredentialSheet } from "./credential-sheet";
import { api } from "@/lib/api";
import {
  LastUse,
  SecretRowMenu,
  SecretRowName,
  UsesDialog,
  type Target,
} from "@/features/bot-secrets/bot-secrets";
import {
  SecretPage,
  type SecretRowProps,
} from "@/features/bot-secrets/secret-page";

const credentialsOf = (data: Credentials) => data.credentials;

const requestsOf = (data: Credentials) => data.requests;

function CredentialRow({
  item: credential,
  onEdit,
  onUses,
  onDelete,
}: SecretRowProps<Credential>) {
  // A GitHub token follows its App or machine account; the server refuses to change it here.
  const managed = credential.github;

  return (
    <div className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/50">
      <SecretRowName
        name={credential.name}
        hosts={credential.hosts}
        mono
        onEdit={managed ? undefined : onEdit}
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
        onEdit={managed ? undefined : onEdit}
        onDelete={managed ? undefined : onDelete}
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
      load={(query, signal) =>
        api<"agentCredentialUses">(
          `${credentialPath(botId, item.name)}/uses?${query}`,
          { signal },
        )
      }
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
  return (
    <SecretPage
      text={{
        title: "Credentials",
        searchLabel: "Search credentials",
        newLabel: "New credential",
        pillsLabel: "Whose credentials",
        empty: "None yet. The bot asks for one when a coding job needs it.",
        noMatch: "No credentials match your search.",
        note: "Coding jobs get a placeholder for each credential; the value only goes to its hosts. Uses are kept for 90 days.",
        deleteDescription:
          "Requests with its placeholder stop working at once, and its uses are deleted. This cannot be undone.",
      }}
      initialBot={initialBot}
      queryOf={credentialsQuery}
      pathOf={credentialPath}
      refresh={refreshCredentials}
      itemsOf={credentialsOf}
      requestsOf={requestsOf}
      Row={CredentialRow}
      Uses={CredentialUsesDialog}
      Sheet={CredentialSheet}
    />
  );
}

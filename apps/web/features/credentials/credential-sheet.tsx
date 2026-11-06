import { useState } from "react";
import { credentialName } from "@crumble/server/contract/secrets";
import { useMutation } from "@tanstack/react-query";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  SecretSourceField,
  keepPlaceholder,
  useSecretDraft,
} from "@/features/password-managers/secret-source-field";
import {
  SecretSheet,
  defaultOwner,
  hostList,
} from "@/features/bot-secrets/bot-secrets";
import type { Bot } from "@/features/bots/api";
import { call } from "@/lib/api";
import {
  type Credential,
  type CredentialRequest,
  credentialPath,
  invalidateCredentials,
} from "./api";

const validName = (name: string) => credentialName.safeParse(name).success;

type Secret = ReturnType<typeof useSecretDraft>;

function useSaveCredential(
  botId: string,
  draft: { name: string; hosts: string; secret: Secret },
  onClose: () => void,
) {
  return useMutation({
    mutationFn: () =>
      call<"saveAgentCredential">(credentialPath(botId, draft.name), "PUT", {
        hosts: hostList(draft.hosts),
        ...(draft.secret.changed &&
          draft.secret.input && { secret: draft.secret.input }),
      }),
    onSuccess: async () => {
      await invalidateCredentials(botId);
      onClose();
    },
  });
}

function credentialReady(
  name: string,
  hosts: string,
  secret: Secret,
  existing: Credential | null,
  pending: boolean,
) {
  return (
    validName(name) &&
    hostList(hosts).length > 0 &&
    (existing !== null || secret.input !== null) &&
    !pending
  );
}

export function CredentialSheet({
  bots,
  botId,
  existing,
  request,
  onClose,
}: {
  bots: Bot[];
  botId: string | null;
  existing: Credential | null;
  request: CredentialRequest | undefined;
  onClose: () => void;
}) {
  const source = existing ?? request;
  const [owner, setOwner] = useState(() => defaultOwner(botId, bots));
  const [name, setName] = useState(source?.name ?? "");
  const [hosts, setHosts] = useState(() => (source?.hosts ?? []).join(", "));
  const secret = useSecretDraft(existing?.secret ?? undefined);

  const save = useSaveCredential(owner, { name, hosts, secret }, onClose);
  const ready = credentialReady(name, hosts, secret, existing, save.isPending);

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
        locked={source !== undefined}
        proposed={request !== undefined}
        draft={{ name, hosts }}
        onName={setName}
        onHosts={setHosts}
      />
      <SecretSourceField
        id="credential-value"
        label="Value"
        {...secret.field}
        valuePlaceholder={keepPlaceholder(existing?.secret)}
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
  const nameInvalid = draft.name !== "" && !validName(draft.name);

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

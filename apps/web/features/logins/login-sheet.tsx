import { useState } from "react";
import { loginName, ONE_PASSWORD_ITEM } from "@crumble/server/contract/secrets";
import { useMutation } from "@tanstack/react-query";
import {
  SecretSheet,
  defaultOwner,
  hostList,
} from "@/features/bot-secrets/bot-secrets";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SecretSourceField,
  keepPlaceholder,
  useConnectedPasswordManagers,
  useSecretDraft,
} from "@/features/password-managers/secret-source-field";
import type { Bot } from "@/features/bots/api";
import { type Login, type LoginRequest, loginPath, refreshLogins } from "./api";
import { call, type RequestBody } from "@/lib/api";

const validName = (name: string) => loginName.safeParse(name).success;

const ITEM = new RegExp(`^${ONE_PASSWORD_ITEM}$`);

type LoginBody = RequestBody<"saveAgentLogin">;

type Draft = {
  name: string;
  hosts: string;
  mode: "fields" | "item";
  item: string;
  hasCode: boolean;
};

type Secret = ReturnType<typeof useSecretDraft>;

type Secrets = { username: Secret; password: Secret; code: Secret };

const fieldBody = (secret: Secret) =>
  secret.changed && secret.input ? secret.input : undefined;

function codeBody(draft: Draft, existing: Login | null, code: Secret) {
  if (!draft.hasCode) return existing?.fields.one_time_code ? null : undefined;

  return fieldBody(code);
}

function loginBody(
  draft: Draft,
  existing: Login | null,
  secrets: Secrets,
): LoginBody {
  const hosts = hostList(draft.hosts);

  if (draft.mode === "item")
    return {
      hosts,
      item: { passwordManager: "1password", reference: draft.item.trim() },
    };

  const fields = {
    username: fieldBody(secrets.username),
    password: fieldBody(secrets.password),
    one_time_code: codeBody(draft, existing, secrets.code),
  };

  return {
    hosts,
    fields: Object.fromEntries(
      Object.entries(fields).filter(([, body]) => body !== undefined),
    ),
  };
}

function draftOf(existing: Login | null, request?: LoginRequest): Draft {
  const source = existing ?? request;

  return {
    name: source?.name ?? "",
    hosts: (source?.hosts ?? []).join(", "),
    mode: "fields",
    item: "",
    hasCode: Boolean(existing?.fields.one_time_code ?? request?.oneTimeCode),
  };
}

function fieldsReady(draft: Draft, existing: Login | null, secrets: Secrets) {
  if (draft.hasCode && !existing?.fields.one_time_code && !secrets.code.input)
    return false;

  return (
    existing !== null ||
    (secrets.username.input !== null && secrets.password.input !== null)
  );
}

function loginReady(draft: Draft, existing: Login | null, secrets: Secrets) {
  if (!validName(draft.name) || !hostList(draft.hosts).length) return false;

  return draft.mode === "item"
    ? ITEM.test(draft.item.trim())
    : fieldsReady(draft, existing, secrets);
}

function useSaveLogin(
  botId: string,
  draft: Draft,
  existing: Login | null,
  secrets: Secrets,
  onClose: () => void,
) {
  return useMutation({
    mutationFn: () =>
      call<"saveAgentLogin">(
        loginPath(botId, draft.name),
        "PUT",
        loginBody(draft, existing, secrets),
      ),
    onSuccess: async () => {
      await refreshLogins(botId);
      onClose();
    },
  });
}

export function LoginSheet({
  bots,
  botId,
  existing,
  request,
  onClose,
}: {
  bots: Bot[];
  botId: string | null;
  existing: Login | null;
  request: LoginRequest | undefined;
  onClose: () => void;
}) {
  const [owner, setOwner] = useState(() => defaultOwner(botId, bots));
  const [draft, setDraft] = useState(() => draftOf(existing, request));

  const secrets: Secrets = {
    username: useSecretDraft(existing?.fields.username),
    password: useSecretDraft(existing?.fields.password),
    code: useSecretDraft(existing?.fields.one_time_code),
  };

  const save = useSaveLogin(owner, draft, existing, secrets, onClose);
  const ready = loginReady(draft, existing, secrets) && !save.isPending;

  const change = (next: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...next }));

  return (
    <SecretSheet
      noun="Login"
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
      <NameAndHosts
        draft={draft}
        locked={existing !== null || request !== undefined}
        proposed={request !== undefined}
        onChange={change}
      />
      <LoginSource
        draft={draft}
        existing={existing}
        secrets={secrets}
        onChange={change}
      />
    </SecretSheet>
  );
}

function LoginSource({
  draft,
  existing,
  secrets,
  onChange,
}: {
  draft: Draft;
  existing: Login | null;
  secrets: Secrets;
  onChange: (next: Partial<Draft>) => void;
}) {
  const connected = useConnectedPasswordManagers();
  const onePassword = connected.some((manager) => manager.id === "1password");

  return (
    <>
      {onePassword && (
        <Tabs
          value={draft.mode}
          onValueChange={(mode) =>
            onChange({ mode: mode === "item" ? "item" : "fields" })
          }
        >
          <TabsList aria-label="How the login is filled">
            <TabsTrigger value="fields">Fields</TabsTrigger>
            <TabsTrigger value="item">1Password item</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {draft.mode === "item" ? (
        <ItemField item={draft.item} onChange={(item) => onChange({ item })} />
      ) : (
        <LoginFields
          draft={draft}
          existing={existing}
          secrets={secrets}
          onChange={onChange}
        />
      )}
    </>
  );
}

function NameAndHosts({
  draft,
  locked,
  proposed,
  onChange,
}: {
  draft: Draft;
  locked: boolean;
  proposed: boolean;
  onChange: (next: Partial<Draft>) => void;
}) {
  const nameInvalid = draft.name !== "" && !validName(draft.name);

  return (
    <>
      <Field data-invalid={nameInvalid || undefined}>
        <FieldLabel htmlFor="login-name">Name</FieldLabel>
        <Input
          id="login-name"
          placeholder="github"
          autoComplete="off"
          disabled={locked}
          aria-invalid={nameInvalid || undefined}
          value={draft.name}
          onChange={(event) =>
            onChange({ name: event.target.value.toLowerCase() })
          }
        />
        <FieldDescription>How desktop jobs refer to it.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="login-hosts">Hosts</FieldLabel>
        <Input
          id="login-hosts"
          placeholder="github.com, *.github.com"
          autoComplete="off"
          value={draft.hosts}
          onChange={(event) => onChange({ hosts: event.target.value })}
        />
        <FieldDescription>
          {proposed
            ? "The bot proposed these. The login is filled only into https pages on them, so check they belong to the site."
            : "Filled only into https pages on these hosts. *.example.com covers every subdomain."}
        </FieldDescription>
      </Field>
    </>
  );
}

function ItemField({
  item,
  onChange,
}: {
  item: string;
  onChange: (item: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor="login-item">Item</FieldLabel>
      <Input
        id="login-item"
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        placeholder="op://vault/item"
        value={item}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>
        Fills the item's username, password, and one-time code, if it has one.
        Crumble checks it can read them when you save.
      </FieldDescription>
    </Field>
  );
}

function LoginFields({
  draft,
  existing,
  secrets,
  onChange,
}: {
  draft: Draft;
  existing: Login | null;
  secrets: Secrets;
  onChange: (next: Partial<Draft>) => void;
}) {
  return (
    <>
      <SecretSourceField
        id="login-username"
        label="Username"
        concealed={false}
        {...secrets.username.field}
        valuePlaceholder={keepPlaceholder(existing?.fields.username)}
      />
      <SecretSourceField
        id="login-password"
        label="Password"
        {...secrets.password.field}
        valuePlaceholder={keepPlaceholder(existing?.fields.password)}
        valueDescription="Stored encrypted and never shown again. Desktop jobs fill it without seeing it."
      />
      <Field orientation="horizontal">
        <FieldLabel htmlFor="login-has-code">One-time code</FieldLabel>
        <Switch
          id="login-has-code"
          checked={draft.hasCode}
          onCheckedChange={(hasCode) => onChange({ hasCode })}
        />
      </Field>
      {draft.hasCode && (
        <SecretSourceField
          id="login-code"
          label="One-time code secret"
          {...secrets.code.field}
          valuePlaceholder={keepPlaceholder(existing?.fields.one_time_code)}
          valueDescription="The setup key or otpauth:// URI from the site's two-factor setup. Crumble computes each code from it."
        />
      )}
    </>
  );
}

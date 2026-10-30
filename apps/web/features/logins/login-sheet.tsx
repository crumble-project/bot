import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { EditorSheet } from "@/components/form-fields";
import { OwnerField, hostList } from "@/components/bot-secrets";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SecretSourceField,
  referenceOf,
  sourceDraftOf,
  useConnectedPasswordManagers,
  type SecretSourceDraft,
} from "@/components/secret-source-field";
import {
  type Bot,
  type Login,
  type LoginRequest,
  type PasswordManagerId,
  call,
  loginPath,
  loginsQuery,
  queryClient,
} from "@/lib/api";

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const ITEM = /^op:\/\/[^/]+\/[^/]+$/;

type Reference = { passwordManager: PasswordManagerId; reference: string };

type FieldBody = { value: string } | { reference: Reference };

type LoginBody = {
  hosts: string[];
  item?: { passwordManager: "1password"; reference: string };
  fields?: {
    username?: FieldBody;
    password?: FieldBody;
    one_time_code?: FieldBody | null;
  };
};

type Draft = {
  name: string;
  hosts: string;
  mode: "fields" | "item";
  item: string;
  username: SecretSourceDraft;
  password: SecretSourceDraft;
  code: SecretSourceDraft;
  hasCode: boolean;
};

type FieldSource = Login["fields"]["password"];

const savedSource = (field: FieldSource) =>
  sourceDraftOf(field?.passwordManager, field?.reference);

const hasSource = (draft: SecretSourceDraft) =>
  draft.kind === "value" ? draft.value !== "" : referenceOf(draft) !== null;

/** A field's new source, or undefined to keep the saved one. */
function fieldBody(
  draft: SecretSourceDraft,
  saved: FieldSource,
): FieldBody | undefined {
  if (draft.kind === "value")
    return draft.value ? { value: draft.value } : undefined;

  const reference = referenceOf(draft);

  if (
    !reference ||
    (reference.passwordManager === saved?.passwordManager &&
      reference.reference === saved.reference)
  )
    return undefined;

  return { reference };
}

function codeBody(draft: Draft, existing: Login | null) {
  if (!draft.hasCode) return existing?.fields.one_time_code ? null : undefined;

  return fieldBody(draft.code, existing?.fields.one_time_code);
}

function loginBody(draft: Draft, existing: Login | null): LoginBody {
  const hosts = hostList(draft.hosts);

  if (draft.mode === "item")
    return {
      hosts,
      item: { passwordManager: "1password", reference: draft.item.trim() },
    };

  const fields = {
    username: fieldBody(draft.username, existing?.fields.username),
    password: fieldBody(draft.password, existing?.fields.password),
    one_time_code: codeBody(draft, existing),
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
    username: savedSource(existing?.fields.username),
    password: savedSource(existing?.fields.password),
    code: savedSource(existing?.fields.one_time_code),
    hasCode: Boolean(existing?.fields.one_time_code ?? request?.oneTimeCode),
  };
}

function fieldsReady(draft: Draft, existing: Login | null) {
  if (
    draft.hasCode &&
    !existing?.fields.one_time_code &&
    !hasSource(draft.code)
  )
    return false;

  return (
    existing !== null ||
    (hasSource(draft.username) && hasSource(draft.password))
  );
}

function loginReady(draft: Draft, existing: Login | null) {
  if (!NAME.test(draft.name) || !hostList(draft.hosts).length) return false;

  return draft.mode === "item"
    ? ITEM.test(draft.item.trim())
    : fieldsReady(draft, existing);
}

function useSaveLogin(
  botId: string,
  draft: Draft,
  existing: Login | null,
  onClose: () => void,
) {
  return useMutation({
    mutationFn: () =>
      call<Login, LoginBody>(
        loginPath(botId, draft.name),
        "PUT",
        loginBody(draft, existing),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: loginsQuery(botId).queryKey,
      });
      onClose();
    },
  });
}

function sheetLabels(existing: Login | null) {
  return existing
    ? { title: `Edit ${existing.name}`, submitLabel: "Save" }
    : { title: "New Login", submitLabel: "Add" };
}

/** Creates or edits a login; values are written once and never shown again. */
export function LoginSheet({
  bots,
  botId,
  existing,
  request,
  onClose,
}: {
  bots: Bot[];
  /** Null for a new login from all bots: the sheet asks which bot it is for. */
  botId: string | null;
  existing: Login | null;
  /** The bot's request this login answers; its name, hosts, and reason fill the sheet. */
  request?: LoginRequest | undefined;
  onClose: () => void;
}) {
  const [owner, setOwner] = useState(botId ?? bots[0]?.id ?? "");
  const [draft, setDraft] = useState(() => draftOf(existing, request));
  const save = useSaveLogin(owner, draft, existing, onClose);
  const ready = loginReady(draft, existing) && !save.isPending;

  const change = (next: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...next }));

  return (
    <EditorSheet
      {...sheetLabels(existing)}
      description={request?.reason}
      error={save.error?.message}
      submitDisabled={!ready}
      onSubmit={() => ready && save.mutate()}
      onClose={onClose}
    >
      <OwnerField bots={bots} botId={botId} owner={owner} onOwner={setOwner} />
      <NameAndHosts
        draft={draft}
        locked={existing !== null || request !== undefined}
        proposed={request !== undefined}
        onChange={change}
      />
      <LoginSource draft={draft} existing={existing} onChange={change} />
    </EditorSheet>
  );
}

/** The login's fields one by one, or a 1Password item that fills them all. */
function LoginSource({
  draft,
  existing,
  onChange,
}: {
  draft: Draft;
  existing: Login | null;
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
          connected={connected}
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
  const nameInvalid = draft.name !== "" && !NAME.test(draft.name);

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
  connected,
  onChange,
}: {
  draft: Draft;
  existing: Login | null;
  connected: ReturnType<typeof useConnectedPasswordManagers>;
  onChange: (next: Partial<Draft>) => void;
}) {
  const keep = (field: FieldSource) =>
    field && field.passwordManager === null
      ? "Keep the saved value"
      : undefined;

  return (
    <>
      <SecretSourceField
        id="login-username"
        label="Username"
        concealed={false}
        value={draft.username}
        onChange={(username) => onChange({ username })}
        connected={connected}
        valuePlaceholder={keep(existing?.fields.username)}
        valueDescription="Stored encrypted and never shown again."
      />
      <SecretSourceField
        id="login-password"
        label="Password"
        value={draft.password}
        onChange={(password) => onChange({ password })}
        connected={connected}
        valuePlaceholder={keep(existing?.fields.password)}
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
          value={draft.code}
          onChange={(code) => onChange({ code })}
          connected={connected}
          valuePlaceholder={keep(existing?.fields.one_time_code)}
          valueDescription="The setup key or otpauth:// URI from the site's two-factor setup. Crumble computes each code from it."
        />
      )}
    </>
  );
}

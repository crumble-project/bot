import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type PasswordManager,
  type PasswordManagerId,
  type SecretStatus,
  passwordManagersQuery,
} from "@/lib/secrets";

/** What the owner is entering: a value to store in Crumble, or where a password manager holds it. */
type SecretSourceDraft =
  | { kind: "value"; value: string }
  | {
      kind: "reference";
      passwordManager: PasswordManagerId;
      reference: string;
    };

const EMPTY_SOURCE: SecretSourceDraft = { kind: "value", value: "" };

const REFERENCE_PLACEHOLDERS = {
  "1password": "op://vault/item/field",
  bitwarden: "Secret ID",
} as const satisfies Record<PasswordManagerId, string>;

/** The reference the request sends, or null when the draft holds a value. */
const referenceOf = (draft: SecretSourceDraft) =>
  draft.kind === "reference" && draft.reference.trim()
    ? {
        passwordManager: draft.passwordManager,
        reference: draft.reference.trim(),
      }
    : null;

/** The password managers a secret can read from now. */
export function useConnectedPasswordManagers(): PasswordManager[] {
  return (useQuery(passwordManagersQuery).data ?? []).filter(
    (manager) => manager.connected,
  );
}

/** The body every secret endpoint takes. */
export type SecretInput =
  | { value: string }
  | { reference: NonNullable<ReturnType<typeof referenceOf>> };

/**
 * A secret's draft for `SecretSourceField`, starting from its saved status. `input` is the body to send, null while the
 * draft is empty; `changed` is false for the saved reference, so saving other fields doesn't read it again.
 */
export function useSecretDraft(saved?: SecretStatus) {
  // A saved reference starts the draft; a value stored in Crumble is never shown, so it starts empty.
  const [draft, setDraft] = useState<SecretSourceDraft>(() =>
    saved?.passwordManager && saved.reference
      ? {
          kind: "reference",
          passwordManager: saved.passwordManager,
          reference: saved.reference,
        }
      : EMPTY_SOURCE,
  );

  const connected = useConnectedPasswordManagers();
  const reference = referenceOf(draft);

  const input: SecretInput | null = reference
    ? { reference }
    : draft.kind === "value" && draft.value
      ? { value: draft.value }
      : null;

  const changed =
    input !== null &&
    !(
      reference &&
      reference.passwordManager === saved?.passwordManager &&
      reference.reference === saved.reference
    );

  return {
    field: { value: draft, onChange: setDraft, connected },
    input,
    changed,
  };
}

const STORED_NOTE = "Stored encrypted and never shown again.";

/** A value stored in Crumble is kept unless a new one is typed. */
export const keepPlaceholder = (saved: SecretStatus | null | undefined) =>
  saved?.configured && !saved.passwordManager
    ? "Keep the saved value"
    : undefined;

/** A secret's value, or a password manager reference once one is connected. */
export function SecretSourceField({
  id,
  label,
  value,
  onChange,
  connected,
  valuePlaceholder,
  valueDescription = STORED_NOTE,
  concealed = true,
  disabled,
}: {
  id: string;
  label: string;
  value: SecretSourceDraft;
  onChange: (next: SecretSourceDraft) => void;
  connected: PasswordManager[];
  valuePlaceholder?: string | undefined;
  valueDescription?: ReactNode;
  /** False for a value that isn't secret, like a username. */
  concealed?: boolean;
  disabled?: boolean;
}) {
  const source = value.kind === "value" ? "crumble" : value.passwordManager;

  const manager = connected.find(
    (item) => value.kind === "reference" && item.id === value.passwordManager,
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {connected.length > 0 && (
        <Tabs
          value={source}
          onValueChange={(next) => {
            const picked = connected.find((item) => item.id === next);

            onChange(
              picked
                ? {
                    kind: "reference",
                    passwordManager: picked.id,
                    reference: "",
                  }
                : EMPTY_SOURCE,
            );
          }}
        >
          <TabsList aria-label={`Where ${label.toLowerCase()} comes from`}>
            <TabsTrigger value="crumble">Crumble</TabsTrigger>
            {connected.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {value.kind === "value" ? (
        <Input
          id={id}
          type={concealed ? "password" : "text"}
          autoComplete="off"
          disabled={disabled}
          placeholder={valuePlaceholder}
          value={value.value}
          onChange={(event) =>
            onChange({ kind: "value", value: event.target.value })
          }
        />
      ) : (
        <Input
          id={id}
          autoComplete="off"
          disabled={disabled}
          spellCheck={false}
          className="font-mono"
          placeholder={REFERENCE_PLACEHOLDERS[value.passwordManager]}
          value={value.reference}
          onChange={(event) =>
            onChange({ ...value, reference: event.target.value })
          }
        />
      )}
      <FieldDescription>
        {value.kind === "reference" ? (
          `Read from ${manager?.name ?? "the password manager"} when it's used. Crumble checks it can read it when you save.`
        ) : connected.length > 0 ? (
          valueDescription
        ) : (
          <>
            {valueDescription}{" "}
            <Link to="/settings/password-managers" className="underline">
              Connect a password manager
            </Link>{" "}
            to read it from there instead.
          </>
        )}
      </FieldDescription>
    </Field>
  );
}

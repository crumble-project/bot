import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type PasswordManager,
  type PasswordManagerId,
  passwordManagersQuery,
} from "@/lib/api";

/** What the owner is entering: a value to store in Crumble, or where a password manager holds it. */
export type SecretSourceDraft =
  | { kind: "value"; value: string }
  | {
      kind: "reference";
      passwordManager: PasswordManagerId;
      reference: string;
    };

export const EMPTY_SOURCE: SecretSourceDraft = { kind: "value", value: "" };

const REFERENCE_PLACEHOLDERS = {
  "1password": "op://vault/item/field",
  bitwarden: "Secret ID",
} as const satisfies Record<PasswordManagerId, string>;

/** A saved reference as a draft, or an empty value when the secret is stored in Crumble. */
export const sourceDraftOf = (
  passwordManager: PasswordManagerId | null | undefined,
  reference: string | null | undefined,
): SecretSourceDraft =>
  passwordManager && reference
    ? { kind: "reference", passwordManager, reference }
    : EMPTY_SOURCE;

/** The reference the request sends, or null when the draft holds a value. */
export const referenceOf = (draft: SecretSourceDraft) =>
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

/** A secret's value, or a password manager reference once one is connected. */
export function SecretSourceField({
  id,
  label,
  value,
  onChange,
  connected,
  valuePlaceholder,
  valueDescription,
}: {
  id: string;
  label: string;
  value: SecretSourceDraft;
  onChange: (next: SecretSourceDraft) => void;
  connected: PasswordManager[];
  valuePlaceholder?: string | undefined;
  valueDescription: ReactNode;
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
          type="password"
          autoComplete="off"
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

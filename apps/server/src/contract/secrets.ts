import { z } from "zod";
import { guestTrustEnv } from "../shared/guest-env";
import {
  MAX_CREDENTIAL_HOSTS,
  MAX_CREDENTIAL_HOST_CHARS,
  MAX_SECRET_CHARS,
} from "../shared/limits";
import { PASSWORD_MANAGER_IDS } from "../shared/vendors";

// Names the workspace, its shell, or the credential proxy itself depend on.
const RESERVED_CREDENTIAL_NAMES = new Set([
  ...Object.keys(guestTrustEnv("", "")),
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TERM",
  "LANG",
  "HOSTNAME",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_OPTIONS",
  "SSL_CERT_DIR",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
]);

export const credentialName = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]{0,63}$/,
    "Credential names are environment variable names such as ACME_TOKEN",
  )
  .refine(
    (name) =>
      !RESERVED_CREDENTIAL_NAMES.has(name) &&
      !name.startsWith("CRUMBLE_") &&
      !name.startsWith("GIT_CONFIG_"),
    "This name is reserved for the workspace",
  );

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A public DNS name, or `*.` and one: the hosts a credential may be sent to. Addresses are not names. */
const credentialHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_CREDENTIAL_HOST_CHARS)
  .refine((host) => {
    const labels = host.replace(/^\*\./, "").split(".");

    return (
      labels.length >= 2 &&
      labels.every((label) => HOST_LABEL.test(label)) &&
      !/^[0-9]+$/.test(labels.at(-1)!)
    );
  }, "Hosts look like api.example.com or *.example.com");

export const credentialHosts = z
  .array(credentialHost)
  .min(1, "Name at least one host")
  .max(MAX_CREDENTIAL_HOSTS)
  .transform((hosts) => [...new Set(hosts)]);

export const passwordManagerIdInput = z.enum(PASSWORD_MANAGER_IDS);

/** Settings key of a password manager: never rename. */
export type PasswordManagerId = z.infer<typeof passwordManagerIdInput>;

const secretReferenceInput = z.object({
  passwordManager: passwordManagerIdInput,
  reference: z.string().trim().min(1).max(1000),
});

export type SecretReference = z.infer<typeof secretReferenceInput>;

// One object with optional fields rather than a union, so client generators keep it.
/** A secret the owner enters: a value to store in Crumble, kept exactly as sent, or a password manager reference. */
export const secretInput = z
  .object({
    value: z.string().min(1).max(MAX_SECRET_CHARS).optional(),
    reference: secretReferenceInput.optional(),
  })
  .strict()
  .refine(
    (input) => (input.value === undefined) !== (input.reference === undefined),
    { message: "Send exactly one of value or reference" },
  );

export type SecretInput = z.infer<typeof secretInput>;

export type SecretStatus = {
  configured: boolean;
  /** The password manager the value is read from; null for a value stored in Crumble or no value. */
  passwordManager: PasswordManagerId | null;
  reference: string | null;
};

export const credentialSaveInput = z.object({
  /** Kept when omitted; required for a credential nobody asked for. */
  hosts: credentialHosts.optional(),
  /** A new credential needs it; omit it to keep the saved one. */
  secret: secretInput.optional(),
});

export const loginName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    "Login names look like github or acme-portal",
  );

export const loginFieldInput = z.enum([
  "username",
  "password",
  "one_time_code",
]);

export type LoginField = z.infer<typeof loginFieldInput>;

/** The grammar of a 1Password item reference; a field reference continues it with `/<field>`. */
export const ONE_PASSWORD_ITEM = "op:\\/\\/[^/]+\\/[^/]+";

/** A 1Password item, `op://<vault>/<item>`, that fills every field of a login. */
const loginItemInput = z.object({
  passwordManager: z.literal("1password"),
  reference: z
    .string()
    .trim()
    .regex(
      new RegExp(`^${ONE_PASSWORD_ITEM}$`),
      "An item reference looks like op://vault/item",
    ),
});

export const loginSaveInput = z
  .object({
    /** Kept when omitted; required for a new login. */
    hosts: credentialHosts.optional(),
    item: loginItemInput.optional(),
    /** Fields to change; null removes the one-time code, whose value is the TOTP secret or an `otpauth://totp/` URI. */
    fields: z
      .object({
        username: secretInput.optional(),
        password: secretInput.optional(),
        one_time_code: secretInput.nullable().optional(),
      })
      .optional(),
  })
  .refine((input) => !(input.item && input.fields), {
    message: "Send an item or fields, not both",
    path: ["item"],
  });

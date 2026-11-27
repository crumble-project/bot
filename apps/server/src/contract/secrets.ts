import { z } from "zod";
import { guestTrustEnv } from "../shared/guest-env";
import {
  MAX_CREDENTIAL_HOSTS,
  MAX_CREDENTIAL_HOST_CHARS,
  MAX_SECRET_CHARS,
} from "../shared/limits";
import { PASSWORD_MANAGER_IDS } from "../shared/vendors";

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
      !/^[0-9]+$/.test(labels.at(-1) ?? "")
    );
  }, "Hosts look like api.example.com or *.example.com");

export const credentialHosts = z
  .array(credentialHost)
  .min(1, "Name at least one host")
  .max(MAX_CREDENTIAL_HOSTS)
  .transform((hosts) => [...new Set(hosts)]);

export const passwordManagerIdInput = z.enum(PASSWORD_MANAGER_IDS);

export type PasswordManagerId = z.infer<typeof passwordManagerIdInput>;

const secretReferenceInput = z.object({
  passwordManager: passwordManagerIdInput,
  reference: z.string().trim().min(1).max(1000),
});

export type SecretReference = z.infer<typeof secretReferenceInput>;

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

export const providerKeyInput = z
  .object({
    value: z.string().min(1).max(MAX_SECRET_CHARS).optional(),
    reference: secretReferenceInput.optional(),
    baseUrl: z.string().trim().min(1).max(2048).optional(),
  })
  .strict()
  .refine(
    (input) => !(input.value !== undefined && input.reference !== undefined),
    { message: "Send at most one of value or reference" },
  )
  .refine(
    (input) =>
      input.value !== undefined ||
      input.reference !== undefined ||
      input.baseUrl !== undefined,
    { message: "Send value, reference, or baseUrl" },
  );

export type ProviderKeyInput = z.infer<typeof providerKeyInput>;

export type SecretStatus = {
  configured: boolean;
  passwordManager: PasswordManagerId | null;
  reference: string | null;
};

export const credentialSaveInput = z.object({
  hosts: credentialHosts.optional(),
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

export const ONE_PASSWORD_ITEM = String.raw`op:\/\/[^/]+\/[^/]+`;

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
    hosts: credentialHosts.optional(),
    item: loginItemInput.optional(),
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

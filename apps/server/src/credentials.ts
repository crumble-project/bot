import { randomBytes } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
  AppError,
  credentialName,
  credentialRequestInput,
  type AgentCredential,
  type CredentialRequestInput,
  type CredentialSaveInput,
  type CredentialUse,
} from "./domain";
import type { Store } from "./store";
import { GUEST_CA_BUNDLE, GUEST_CA_PATH } from "./workspace";

export const REQUEST_CREDENTIAL_TOOL = "request_credential";

/** How long the owner can look back at a credential's uses. */
export const CREDENTIAL_USE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Posts a notice to the bot's chat that starts a turn; the request ID names the credential. */
export type CredentialNotice = (
  agentId: string,
  text: string,
  requestId: string,
) => Promise<void>;

const hostsText = (hosts: readonly string[]) => hosts.join(", ");

/**
 * Credentials the owner gives a bot for named hosts. Jobs see only a placeholder per credential; the credential proxy
 * swaps it for the value on requests to those hosts.
 */
export class Credentials {
  constructor(
    private readonly store: Store,
    private readonly notice: CredentialNotice,
  ) {}

  list(agentId: string) {
    return {
      credentials: this.store.listAgentCredentials(agentId),
      requests: this.store.listCredentialRequests(agentId),
    };
  }

  request(agentId: string, request: CredentialRequestInput) {
    const existing = this.store.getAgentCredential(agentId, request.name);

    if (
      existing &&
      request.hosts.every((host) => existing.hosts.includes(host))
    )
      throw new AppError(
        409,
        `${request.name} is already yours for ${hostsText(existing.hosts)}`,
      );

    return this.store.setCredentialRequest(agentId, request);
  }

  /** Creates or updates a credential; saving one the bot asked for answers its request. */
  async save(agentId: string, name: string, input: CredentialSaveInput) {
    const checkedName = credentialName.parse(name);
    const { hosts, value } = input;
    const request = this.store.getCredentialRequest(agentId, checkedName);
    const existing = this.store.getAgentCredential(agentId, checkedName);
    const resolvedHosts = hosts ?? existing?.hosts ?? request?.hosts;

    if (!resolvedHosts) throw new AppError(400, "Name at least one host");

    if (!existing && value === undefined)
      throw new AppError(400, "A new credential needs a value");

    const credential = this.store.saveAgentCredential(agentId, checkedName, {
      hosts: resolvedHosts,
      value,
      placeholder: `crumble-credential-${randomBytes(24).toString("hex")}`,
    });

    if (request) {
      this.store.deleteCredentialRequest(agentId, checkedName);
      await this.notify(
        agentId,
        checkedName,
        `The owner saved credential ${checkedName} for ${hostsText(credential.hosts)}. Coding jobs see it as $${checkedName}.`,
      );
    }

    return credential;
  }

  /** Deletes a credential, or declines a request for one. */
  async delete(agentId: string, name: string) {
    if (this.store.deleteAgentCredential(agentId, name)) return;

    if (!this.store.deleteCredentialRequest(agentId, name))
      throw new AppError(404, "Credential not found");

    await this.notify(
      agentId,
      name,
      `The owner declined your request for credential ${name}.`,
    );
  }

  uses(
    agentId: string,
    name: string,
    options: { limit: number; before?: string | undefined },
  ) {
    if (!this.store.getAgentCredential(agentId, name))
      throw new AppError(404, "Credential not found");
    this.prune();

    return this.store.listCredentialUses(agentId, name, options);
  }

  /** The variables every command of the bot's coding jobs sees: placeholders, and where to find the bot's authority. */
  env(agentId: string) {
    const placeholders = this.store.agentCredentialPlaceholders(agentId);

    if (!Object.keys(placeholders).length) return {};

    return {
      ...placeholders,
      SSL_CERT_FILE: GUEST_CA_BUNDLE,
      REQUESTS_CA_BUNDLE: GUEST_CA_BUNDLE,
      CURL_CA_BUNDLE: GUEST_CA_BUNDLE,
      NODE_EXTRA_CA_CERTS: GUEST_CA_PATH,
      // Node's own fetch ignores the proxy variables without it.
      NODE_USE_ENV_PROXY: "1",
    };
  }

  /** What the credential proxy swaps in for the bot's placeholders. */
  grants(agentId: string) {
    return this.store.agentCredentialGrants(agentId);
  }

  recordUse(agentId: string, name: string, use: Omit<CredentialUse, "id">) {
    this.store.addCredentialUse(agentId, name, use);
  }

  prune(now = Date.now()) {
    this.store.pruneCredentialUses(
      new Date(now - CREDENTIAL_USE_RETENTION_MS).toISOString(),
    );
  }

  private async notify(agentId: string, name: string, text: string) {
    try {
      await this.notice(
        agentId,
        text,
        `credential:${name}:${crypto.randomUUID()}`,
      );
    } catch (error) {
      // A disabled bot cannot take the turn; the owner already sees the outcome in its settings.
      console.error("Credential notice failed", agentId, name, error);
    }
  }
}

const credentialLines = (credentials: readonly AgentCredential[]) =>
  credentials.map(
    (credential) => `- ${credential.name}: ${hostsText(credential.hosts)}`,
  );

/** What a coding job reads about the bot's credentials; undefined without any. */
export function jobCredentialSection(credentials: readonly AgentCredential[]) {
  if (!credentials.length) return undefined;

  return [
    "Credentials the owner gave this bot, as environment variables in every command, with the hosts each works for:",
    ...credentialLines(credentials),
    "Each variable holds a placeholder. The workspace's HTTPS proxy replaces it with the real value in request headers and query parameters, only on requests to its hosts. Use the variable as if it held the value, and never print it or write it into files. A client that ignores HTTPS_PROXY sends the placeholder and gets an authentication error: route it through the proxy instead.",
  ].join("\n");
}

const output = (value: JsonValue) => ({
  structuredOutput: value,
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/** The bot's `request_credential` tool and what it knows about its credentials, for bots with coding jobs. */
export function credentialExtension(agentId: string, credentials: Credentials) {
  const request = defineTool({
    name: REQUEST_CREDENTIAL_TOOL,
    description:
      "Ask the owner for a credential your coding jobs need, such as an API token for a service without an MCP server. Name it like an environment variable (ACME_TOKEN), list the hosts it is for (api.acme.com, *.acme.com), and say why. The owner enters the value outside the chat; you never see it. Coding jobs then get the variable with a placeholder that works only on requests to those hosts. After calling, tell the owner what you asked for and why, then end your turn: a message arrives when the owner answers.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 64 }),
      hosts: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
        minItems: 1,
        maxItems: 20,
      }),
      reason: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    replay: "unsafe",
    execute: async (args) => {
      const request = credentials.request(
        agentId,
        credentialRequestInput.parse(args),
      );

      // Clients read the request from the details to offer the owner its form.
      return { ...output({ request }), details: request };
    },
  });

  return defineExtension({
    name: "credentials",
    tools: [request],
    sections: [
      {
        key: "credentials",
        render: () => {
          const { credentials: granted, requests } = credentials.list(agentId);

          if (!granted.length && !requests.length) return undefined;

          return [
            ...(granted.length
              ? [
                  "Credentials your coding jobs have:",
                  ...credentialLines(granted),
                ]
              : []),
            ...(requests.length
              ? [
                  "Credentials you asked for that the owner has not answered:",
                  ...requests.map(
                    (pending) =>
                      `- ${pending.name}: ${hostsText(pending.hosts)}`,
                  ),
                ]
              : []),
          ].join("\n");
        },
      },
    ],
  });
}

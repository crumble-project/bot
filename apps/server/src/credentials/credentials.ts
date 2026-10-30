import { randomBytes } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Clock, Context, Effect, Layer, Predicate, Redacted } from "effect";
import type { Runner } from "../shared/runner";
import { BotNotices } from "../bots/bot-notices";
import {
  credentialName,
  credentialRequestInput,
  type AgentCredential,
  type CredentialGrant,
  type CredentialRequest,
  type CredentialRequestInput,
  type CredentialSaveInput,
  type CredentialUse,
} from "../shared/domain";
import { PasswordManagers } from "../password-managers/password-manager";
import { checkSecretReference } from "../password-managers/secret-references";
import {
  SecretValues,
  type SecretUnavailable,
} from "../password-managers/secret-values";
import { AgentCredentialRepository } from "./agent-credential-repository";
import { GUEST_CA_BUNDLE, GUEST_CA_PATH } from "../workspaces/workspace";
import {
  InvalidInput,
  NotFound,
  Conflict,
  type AppError,
} from "../shared/errors";

export const REQUEST_CREDENTIAL_TOOL = "request_credential";

/** How long the owner can look back at a credential's uses. */
export const CREDENTIAL_USE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const hostsText = (hosts: readonly string[]) => hosts.join(", ");

/** The hosts a save covers: the input's, else the saved credential's, else the pending request's. */
const savedHosts = (
  input: CredentialSaveInput,
  existing: AgentCredential | undefined,
  pending: CredentialRequest | undefined,
) => {
  const hosts = input.hosts ?? existing?.hosts ?? pending?.hosts;

  if (!hosts)
    return Effect.fail(new InvalidInput({ message: "Name at least one host" }));

  if (!existing && input.value === undefined && !input.reference)
    return Effect.fail(
      new InvalidInput({
        message: "A new credential needs a value or a reference",
      }),
    );

  return Effect.succeed(hosts);
};

/**
 * Credentials the owner gives a bot for named hosts. Jobs see only a placeholder per credential; the credential proxy
 * swaps it for the value on requests to those hosts.
 */
export class Credentials extends Context.Service<
  Credentials,
  {
    readonly list: (agentId: string) => Effect.Effect<{
      credentials: AgentCredential[];
      requests: CredentialRequest[];
    }>;
    /** Fails when the bot already has the credential for every host it names. */
    readonly request: (
      agentId: string,
      request: CredentialRequestInput,
    ) => Effect.Effect<CredentialRequest, AppError>;
    /** Creates or updates a credential; saving one the bot asked for answers its request. */
    readonly save: (
      agentId: string,
      name: string,
      input: CredentialSaveInput,
    ) => Effect.Effect<AgentCredential, AppError>;
    /** Deletes a credential, or declines a request for one. */
    readonly delete: (
      agentId: string,
      name: string,
    ) => Effect.Effect<void, AppError>;
    readonly decline: (
      agentId: string,
      name: string,
    ) => Effect.Effect<void, AppError>;
    readonly uses: (
      agentId: string,
      name: string,
      options: { limit: number; before?: string | undefined },
    ) => Effect.Effect<CredentialUse[], AppError>;
    /** The variables every command of the bot's coding jobs sees: placeholders, and where to find the bot's authority. */
    readonly env: (agentId: string) => Effect.Effect<Record<string, string>>;
    /** The placeholders the credential proxy may swap, without their values. */
    readonly grants: (agentId: string) => Effect.Effect<CredentialGrant[]>;
    /** The value the credential proxy swaps in, read only for a request that uses its placeholder. */
    readonly value: (
      agentId: string,
      name: string,
    ) => Effect.Effect<Redacted.Redacted, SecretUnavailable | NotFound>;
    readonly recordUse: (
      agentId: string,
      name: string,
      use: Omit<CredentialUse, "id">,
    ) => Effect.Effect<void>;
    /** Drops uses older than the retention, counted back from now. */
    readonly prune: Effect.Effect<void>;
  }
>()("crumble/credentials/Credentials") {
  static readonly layer = Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const repository = yield* AgentCredentialRepository;
      const notices = yield* BotNotices;
      const values = yield* SecretValues;
      const managers = yield* PasswordManagers;

      /** Drops the cached value of a reference the credential no longer reads. */
      const forgetReplaced = (
        previous: AgentCredential | undefined,
        next: AgentCredential | undefined,
      ) =>
        previous?.passwordManager &&
        previous.reference &&
        (previous.passwordManager !== next?.passwordManager ||
          previous.reference !== next.reference)
          ? values.forget(previous.passwordManager, previous.reference)
          : Effect.void;

      const value = Effect.fn("Credentials.value")(function* (
        agentId: string,
        name: string,
      ) {
        const source = yield* repository.source(agentId, name);

        if (!source)
          return yield* new NotFound({ message: `${name} was deleted` });

        return yield* values.read(source);
      });

      const notify = (agentId: string, name: string, text: string) =>
        notices
          .notice(agentId, text, `credential:${name}:${crypto.randomUUID()}`)
          .pipe(
            // A disabled bot cannot take the turn; the owner already sees the outcome in its settings.
            Effect.catchCause((cause) =>
              Effect.logError("Credential notice failed", agentId, name, cause),
            ),
          );

      const list = Effect.fn("Credentials.list")(function* (agentId: string) {
        return {
          credentials: yield* repository.list(agentId),
          requests: yield* repository.listRequests(agentId),
        };
      });

      const request = Effect.fn("Credentials.request")(function* (
        agentId: string,
        input: CredentialRequestInput,
      ) {
        const existing = yield* repository.get(agentId, input.name);

        if (
          existing &&
          input.hosts.every((host) => existing.hosts.includes(host))
        )
          return yield* Effect.fail(
            new Conflict({
              message: `${input.name} is already yours for ${hostsText(existing.hosts)}`,
            }),
          );

        return yield* repository.setRequest(agentId, input);
      });

      const save = Effect.fn("Credentials.save")(function* (
        agentId: string,
        name: string,
        input: CredentialSaveInput,
      ) {
        const checkedName = yield* Effect.try({
          try: () => credentialName.parse(name),
          catch: (cause) => cause,
        }).pipe(Effect.orDie);

        const { value, reference } = input;

        // Checked before reading the saved credential, so a save made during the read isn't overwritten.
        if (reference)
          yield* checkSecretReference(reference).pipe(
            Effect.provideService(PasswordManagers, managers),
            Effect.provideService(SecretValues, values),
          );

        const pending = yield* repository.getRequest(agentId, checkedName);
        const existing = yield* repository.get(agentId, checkedName);
        const resolvedHosts = yield* savedHosts(input, existing, pending);

        const credential = yield* repository.save(agentId, checkedName, {
          hosts: resolvedHosts,
          value,
          reference,
          placeholder: `crumble-credential-${randomBytes(24).toString("hex")}`,
        });

        yield* forgetReplaced(existing, credential);

        if (pending) {
          yield* repository.deleteRequest(agentId, checkedName);
          yield* notify(
            agentId,
            checkedName,
            `The owner saved credential ${checkedName} for ${hostsText(credential.hosts)}. Coding jobs see it as $${checkedName}.`,
          );
        }

        return credential;
      });

      const remove = Effect.fn("Credentials.delete")(function* (
        agentId: string,
        name: string,
      ) {
        const existing = yield* repository.get(agentId, name);

        if (yield* repository.delete(agentId, name))
          return yield* forgetReplaced(existing, undefined);

        if (!(yield* repository.deleteRequest(agentId, name)))
          return yield* Effect.fail(
            new NotFound({ message: "Credential not found" }),
          );

        yield* notify(
          agentId,
          name,
          `The owner declined your request for credential ${name}.`,
        );
      });

      const decline = Effect.fn("Credentials.decline")(function* (
        agentId: string,
        name: string,
      ) {
        if (!(yield* repository.deleteRequest(agentId, name)))
          return yield* Effect.fail(
            new Conflict({
              message: "Credential request has already been answered",
            }),
          );

        yield* notify(
          agentId,
          name,
          `The owner declined your request for credential ${name}.`,
        );
      });

      const prune = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        yield* repository.pruneUses(
          new Date(now - CREDENTIAL_USE_RETENTION_MS).toISOString(),
        );
      }).pipe(Effect.withSpan("Credentials.prune"));

      const uses = Effect.fn("Credentials.uses")(function* (
        agentId: string,
        name: string,
        options: { limit: number; before?: string | undefined },
      ) {
        if (!(yield* repository.get(agentId, name)))
          return yield* Effect.fail(
            new NotFound({ message: "Credential not found" }),
          );

        yield* prune;

        return yield* repository.listUses(agentId, name, options);
      });

      const env = Effect.fn("Credentials.env")(function* (agentId: string) {
        const placeholders = yield* repository.placeholders(agentId);

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
      });

      return Credentials.of({
        list,
        request,
        save,
        delete: remove,
        decline,
        uses,
        env,
        grants: repository.grants,
        value,
        recordUse: repository.addUse,
        prune,
      });
    }),
  );
}

/** Credentials for code outside Effect: HTTP handlers, the credential proxy, and Pi Durable tools. */
export type CredentialsAccess = {
  list(agentId: string): {
    credentials: AgentCredential[];
    requests: CredentialRequest[];
  };
  request(agentId: string, request: CredentialRequestInput): CredentialRequest;
  save(
    agentId: string,
    name: string,
    input: CredentialSaveInput,
  ): Promise<AgentCredential>;
  delete(agentId: string, name: string): Promise<void>;
  decline(agentId: string, name: string): Promise<void>;
  uses(
    agentId: string,
    name: string,
    options: { limit: number; before?: string | undefined },
  ): CredentialUse[];
  env(agentId: string): Record<string, string>;
  grants(agentId: string): CredentialGrant[];
  /** Rejects with the message the credential proxy answers with. */
  value(agentId: string, name: string): Promise<string>;
  recordUse(
    agentId: string,
    name: string,
    use: Omit<CredentialUse, "id">,
  ): void;
};

export function credentialsAccess(
  runtime: Runner<Credentials>,
): CredentialsAccess {
  const credentials = runtime.runSync(Credentials.use(Effect.succeed));

  return {
    list: (agentId) => runtime.runSync(credentials.list(agentId)),
    request: (agentId, request) =>
      runtime.runSync(credentials.request(agentId, request)),
    save: (agentId, name, input) =>
      runtime.runPromise(credentials.save(agentId, name, input)),
    delete: (agentId, name) =>
      runtime.runPromise(credentials.delete(agentId, name)),
    decline: (agentId, name) =>
      runtime.runPromise(credentials.decline(agentId, name)),
    uses: (agentId, name, options) =>
      runtime.runSync(credentials.uses(agentId, name, options)),
    env: (agentId) => runtime.runSync(credentials.env(agentId)),
    grants: (agentId) => runtime.runSync(credentials.grants(agentId)),
    value: (agentId, name) =>
      runtime.runPromise(
        credentials.value(agentId, name).pipe(
          Effect.map(Redacted.value),
          Effect.mapError(
            (error) =>
              new Error(
                Predicate.isTagged(error, "SecretUnavailable")
                  ? `${name} could not be read: ${error.message}`
                  : error.message,
              ),
          ),
        ),
      ),
    recordUse: (agentId, name, use) =>
      runtime.runSync(credentials.recordUse(agentId, name, use)),
  };
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
    "Each variable holds a placeholder. The workspace's HTTPS proxy replaces it with the real value in request headers, only on requests to its hosts; a placeholder in the URL or body is sent as it is. Use the variable as if it held the value, and never print it or write it into files. A client that ignores HTTPS_PROXY sends the placeholder and gets an authentication error: route it through the proxy instead.",
  ].join("\n");
}

const grantedLines = (granted: readonly AgentCredential[]) =>
  granted.length
    ? ["Credentials your coding jobs have:", ...credentialLines(granted)]
    : [];

const pendingLines = (requests: readonly CredentialRequest[]) =>
  requests.length
    ? [
        "Credentials you asked for that the owner has not answered:",
        ...requests.map(
          (pending) => `- ${pending.name}: ${hostsText(pending.hosts)}`,
        ),
      ]
    : [];

const output = (value: JsonValue) => ({
  structuredOutput: value,
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/** The bot's `request_credential` tool and what it knows about its credentials, for bots with coding jobs. */
export function credentialExtension(
  agentId: string,
  credentials: CredentialsAccess,
) {
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
    // The chat offers the owner the form from this call's own result, so code mode keeps it a direct model tool.
    callers: ["model"],
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

          return [...grantedLines(granted), ...pendingLines(requests)].join(
            "\n",
          );
        },
      },
    ],
  });
}

import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Redacted } from "effect";
import type { Runner } from "../shared/runner";
import {
  hostLines,
  hostsText,
  requestParameters,
  secretRequestTool,
  useFailure,
} from "../bot-secrets/bot-secret-lifecycle";
import {
  credentialName,
  credentialRequestInput,
  type AgentCredential,
  type CredentialGrant,
  type CredentialRequest,
  type CredentialRequestInput,
  type CredentialSaveInput,
  type CredentialTarget,
  type CredentialUse,
} from "../shared/domain";
import type { SecretUnavailable } from "../secrets/secret-values";
import { Secrets } from "../secrets/secrets";
import {
  AgentCredentialRepository,
  credentialSecretKey,
  type CredentialRecord,
} from "./agent-credential-repository";
import {
  CredentialSource,
  credentialLifecycle,
  type CredentialUnminted,
} from "./minted-credentials";
import { guestTrustEnv } from "../shared/guest-env";
import { GUEST_CA_BUNDLE, GUEST_CA_PATH } from "../workspaces/workspace";
import {
  Conflict,
  InvalidInput,
  NotFound,
  type AppError,
} from "../shared/errors";
import { REQUEST_CREDENTIAL_TOOL_NAME } from "../contract/tools";

/** A minted credential's value and hosts are its source's, so the owner's save or delete would break its tokens. */
const refuseMinted = (record: CredentialRecord | undefined) =>
  record?.github
    ? Effect.fail(
        new Conflict({
          message: `${record.name} comes from the bot's GitHub App or machine account; change it there`,
        }),
      )
    : Effect.void;

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
    /** What the bot and its coding jobs read about its credentials; undefined when there is nothing to say. */
    readonly workspaceSection: (
      agentId: string,
    ) => Effect.Effect<string | undefined>;
    /** The placeholders the credential proxy may swap, without their values. */
    readonly grants: (agentId: string) => Effect.Effect<CredentialGrant[]>;
    /** The value the credential proxy swaps in, read only for a request that uses its placeholder. */
    readonly value: (
      agentId: string,
      name: string,
      target: CredentialTarget,
    ) => Effect.Effect<
      Redacted.Redacted,
      SecretUnavailable | CredentialUnminted | NotFound
    >;
    readonly recordUse: (
      agentId: string,
      name: string,
      use: Omit<CredentialUse, "id">,
    ) => Effect.Effect<void>;
  }
>()("crumble/credentials/Credentials") {
  static readonly layer = Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const repository = yield* AgentCredentialRepository;
      const lifecycle = yield* credentialLifecycle;
      const secrets = yield* Secrets;
      const source = yield* CredentialSource;

      const withSecret = Effect.fnUntraced(function* (
        agentId: string,
        record: CredentialRecord,
      ) {
        return {
          ...record,
          secret: record.github
            ? null
            : yield* secrets.status(credentialSecretKey(agentId, record.name)),
        } satisfies AgentCredential;
      });

      const value = Effect.fn("Credentials.value")(function* (
        agentId: string,
        name: string,
        target: CredentialTarget,
      ) {
        const found = yield* repository.get(agentId, name);

        if (found?.github) return yield* source.value(agentId, target);

        const secret =
          found && (yield* secrets.read(credentialSecretKey(agentId, name)));

        if (!secret)
          return yield* new NotFound({ message: `${name} was deleted` });

        return secret;
      });

      const list = Effect.fn("Credentials.list")(function* (agentId: string) {
        return {
          credentials: yield* Effect.forEach(
            yield* repository.list(agentId),
            (record) => withSecret(agentId, record),
          ),
          requests: (yield* lifecycle.requests(agentId)).map(
            ({ name, hosts, reason, requestedAt }) => ({
              name,
              hosts,
              reason,
              requestedAt,
            }),
          ),
        };
      });

      const request = Effect.fn("Credentials.request")(function* (
        agentId: string,
        input: CredentialRequestInput,
      ) {
        return yield* lifecycle.ask(agentId, input, {
          alreadyYours: (existing) =>
            `${input.name} is already yours for ${hostsText(existing.hosts)}`,
        });
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

        const credential = yield* lifecycle.save(agentId, checkedName, {
          hosts: input.hosts,
          check: (existing) =>
            !existing && !input.secret
              ? Effect.fail(
                  new InvalidInput({
                    message: "A new credential needs a value or a reference",
                  }),
                )
              : refuseMinted(existing),
          store: input.secret
            ? secrets.save(
                credentialSecretKey(agentId, checkedName),
                input.secret,
              )
            : Effect.void,
          write: (hosts) =>
            repository.save(agentId, checkedName, { hosts, github: false }),
          notice: (saved) =>
            `The owner saved credential ${checkedName} for ${hostsText(saved.hosts)}. Coding jobs see it as $${checkedName}.`,
        });

        return yield* withSecret(agentId, credential);
      });

      const remove = Effect.fn("Credentials.delete")(function* (
        agentId: string,
        name: string,
      ) {
        yield* refuseMinted(yield* repository.get(agentId, name));
        yield* lifecycle.remove(agentId, name);
      });

      const env = Effect.fn("Credentials.env")(function* (agentId: string) {
        const placeholders = yield* repository.placeholders(agentId);
        const git = yield* source.env(agentId);

        if (!Object.keys(placeholders).length) return git;

        return {
          ...git,
          ...placeholders,
          ...guestTrustEnv(GUEST_CA_BUNDLE, GUEST_CA_PATH),
        };
      });

      return Credentials.of({
        list,
        request,
        save,
        delete: remove,
        decline: lifecycle.decline,
        uses: lifecycle.uses,
        env,
        workspaceSection: Effect.fn("Credentials.workspaceSection")(
          function* (agentId) {
            const { credentials } = yield* list(agentId);

            return workspaceCredentialSection(
              credentials,
              yield* source.lines(agentId),
            );
          },
        ),
        grants: repository.grants,
        value,
        recordUse: lifecycle.recordUse,
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
  workspaceSection(agentId: string): string | undefined;
  grants(agentId: string): CredentialGrant[];
  /** Rejects with the message the credential proxy answers with. */
  value(
    agentId: string,
    name: string,
    target: CredentialTarget,
  ): Promise<string>;
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
    workspaceSection: (agentId) =>
      runtime.runSync(credentials.workspaceSection(agentId)),
    grants: (agentId) => runtime.runSync(credentials.grants(agentId)),
    value: (agentId, name, target) =>
      runtime.runPromise(
        credentials.value(agentId, name, target).pipe(
          Effect.map(Redacted.value),
          Effect.mapError((error) => new Error(useFailure(name, error))),
        ),
      ),
    recordUse: (agentId, name, use) =>
      runtime.runSync(credentials.recordUse(agentId, name, use)),
  };
}

/** The credentials, then `sourceLines`, as the bot and its coding jobs read them; undefined without either. */
function workspaceCredentialSection(
  credentials: readonly AgentCredential[],
  sourceLines: readonly string[],
) {
  if (!credentials.length && !sourceLines.length) return undefined;

  return [
    ...(credentials.length
      ? [
          "Credentials the owner gave this bot, as environment variables in every command, with the hosts each works for:",
          ...hostLines(credentials),
          "Each variable holds a placeholder. The workspace's HTTPS proxy replaces it with the real value in request headers, only on requests to its hosts; a placeholder in the URL or body is sent as it is. Use the variable as if it held the value, and never print it or write it into files. A client that ignores HTTPS_PROXY sends the placeholder and gets an authentication error: route it through the proxy instead.",
        ]
      : []),
    ...sourceLines,
  ].join("\n");
}

const pendingLines = (requests: readonly CredentialRequest[]) =>
  requests.length
    ? [
        "Credentials you asked for that the owner has not answered:",
        ...hostLines(requests),
      ]
    : [];

/** The bot's `request_credential` tool and the requests the owner has not answered, for bots with coding. */
export function credentialExtension(
  agentId: string,
  credentials: CredentialsAccess,
) {
  const request = secretRequestTool({
    name: REQUEST_CREDENTIAL_TOOL_NAME,
    description:
      "Ask the owner for a credential your shell commands or coding jobs need, such as an API token for a service without an MCP server. Name it like an environment variable (ACME_TOKEN), list the hosts it is for (api.acme.com, *.acme.com), and say why. The owner enters the value outside the chat; you never see it. Your commands and coding jobs then get the variable with a placeholder that works only on requests to those hosts. After calling, tell the owner what you asked for and why, then end your turn: a message arrives when the owner answers.",
    parameters: Type.Object(requestParameters),
    request: (args) =>
      credentials.request(agentId, credentialRequestInput.parse(args)),
  });

  return defineExtension({
    name: "credentials",
    tools: [request],
    sections: [
      {
        key: "credentials",
        // The granted ones show in the workspace's credentials section, with how to use them.
        render: () => {
          const { requests } = credentials.list(agentId);

          return requests.length
            ? pendingLines(requests).join("\n")
            : undefined;
        },
      },
    ],
  });
}

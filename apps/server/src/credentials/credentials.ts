import { GUEST_CA_BUNDLE, GUEST_CA_PATH } from "../../workspace-image/guest";
import { z } from "zod";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Redacted } from "effect";
import { accessOf, type Access, type Runner } from "../shared/runner";
import {
  hostLines,
  hostsText,
  requestParameters,
  requestReason,
  secretRequestTool,
  useFailure,
} from "../bot-secrets/bot-secret-lifecycle";
import {
  credentialName,
  credentialHosts,
  credentialSaveInput,
} from "../contract/secrets";
import { type CredentialTarget } from "../shared/domain";
import type {
  AgentCredential,
  CredentialGrant,
  CredentialRequest,
  CredentialUse,
} from "./agent-credential-repository";
import type { SecretUnavailable } from "../secrets/secret-values";
import { Secrets } from "../secrets/secrets";
import {
  AgentCredentialRepository,
  credentialSecretKey,
  type CredentialRecord,
} from "./agent-credential-repository";
import { credentialLifecycle } from "./credential-lifecycle";
import {
  CredentialSource,
  type CredentialUnminted,
} from "./minted-credentials";
import { guestTrustEnv } from "../shared/guest-env";
import {
  Conflict,
  InvalidInput,
  NotFound,
  type AppError,
} from "../shared/errors";
import { REQUEST_CREDENTIAL_TOOL_NAME } from "../contract/tools";

const credentialRequestInput = z.object({
  name: credentialName,
  hosts: credentialHosts,
  reason: requestReason,
});

export type CredentialRequestInput = z.infer<typeof credentialRequestInput>;

export type CredentialSaveInput = z.infer<typeof credentialSaveInput>;

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
    readonly save: (
      agentId: string,
      name: string,
      input: CredentialSaveInput,
    ) => Effect.Effect<AgentCredential, AppError>;
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
    readonly env: (agentId: string) => Effect.Effect<Record<string, string>>;
    readonly workspaceSection: (
      agentId: string,
    ) => Effect.Effect<string | undefined>;
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
        const checkedName = yield* lifecycle.checkedName(name);

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

const SYNC_CREDENTIALS = [
  "list",
  "request",
  "uses",
  "env",
  "workspaceSection",
  "grants",
  "recordUse",
] as const;

export type CredentialsAccess = Omit<
  Access<Credentials["Service"], (typeof SYNC_CREDENTIALS)[number]>,
  "value"
> & {
  /** Rejects with the message the credential proxy answers with. */
  value(
    agentId: string,
    name: string,
    target: CredentialTarget,
  ): Promise<string>;
};

export function credentialsAccess(
  runtime: Runner<Credentials>,
): CredentialsAccess {
  const credentials = runtime.runSync(Credentials.use(Effect.succeed));

  return {
    ...accessOf(credentials, runtime, SYNC_CREDENTIALS),
    value: (agentId, name, target) =>
      runtime.runPromise(
        credentials.value(agentId, name, target).pipe(
          Effect.map(Redacted.value),
          Effect.mapError((error) => new Error(useFailure(name, error))),
        ),
      ),
  };
}

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

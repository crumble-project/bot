import { randomBytes } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Predicate, Redacted } from "effect";
import { z } from "zod";
import type { Runner } from "../shared/runner";
import { BotSecretRequests } from "../bot-secrets/bot-secret-requests";
import { BotSecretUses } from "../bot-secrets/bot-secret-uses";
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
import type { SecretUnavailable } from "../password-managers/secret-values";
import { Secrets } from "../password-managers/secrets";
import {
  AgentCredentialRepository,
  credentialSecretKey,
  type CredentialRecord,
} from "./agent-credential-repository";
import { GitHubApps } from "../github-apps/github-apps";
import type {
  GitHubIdentity,
  GitHubUnavailable,
} from "../github-apps/github-api";
import { GUEST_CA_BUNDLE, GUEST_CA_PATH } from "../workspaces/workspace";
import {
  InvalidInput,
  NotFound,
  Conflict,
  type AppError,
} from "../shared/errors";
import { toolOutput } from "../shared/tool-output";
import { REQUEST_CREDENTIAL_TOOL_NAME } from "../contract/tools";
import {
  MAX_CREDENTIAL_HOST_CHARS,
  MAX_CREDENTIAL_HOSTS,
  MAX_CREDENTIAL_NAME_CHARS,
  MAX_REQUEST_REASON_CHARS,
} from "../shared/limits";

const hostsText = (hosts: readonly string[]) => hosts.join(", ");

/** What a credential's use records beyond its host: the request it was swapped into. */
const useDetail = z.object({
  method: z.string(),
  path: z.string(),
  status: z.number().nullable(),
});

/** The hosts a save covers: the input's, else the saved credential's, else the pending request's. */
const savedHosts = (
  input: CredentialSaveInput,
  existing: CredentialRecord | undefined,
  pending: CredentialRequest | undefined,
) => {
  const hosts = input.hosts ?? existing?.hosts ?? pending?.hosts;

  if (!hosts)
    return Effect.fail(new InvalidInput({ message: "Name at least one host" }));

  if (!existing && !input.secret)
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
    /** How the bot commits in each GitHub account its Apps work in, and elsewhere as its machine account, default first. */
    readonly githubIdentities: (
      agentId: string,
    ) => Effect.Effect<GitHubIdentity[]>;
    /** The placeholders the credential proxy may swap, without their values. */
    readonly grants: (agentId: string) => Effect.Effect<CredentialGrant[]>;
    /** The value the credential proxy swaps in, read only for a request that uses its placeholder. */
    readonly value: (
      agentId: string,
      name: string,
      target: CredentialTarget,
    ) => Effect.Effect<
      Redacted.Redacted,
      SecretUnavailable | GitHubUnavailable | NotFound
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
      const requests = yield* BotSecretRequests;
      const useLog = yield* BotSecretUses;
      const secrets = yield* Secrets;
      const githubApps = yield* GitHubApps;

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

        if (found?.github) return yield* githubApps.token(agentId, target);

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
          requests: (yield* requests.list(agentId, "credential")).map(
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

        return yield* requests.ask(agentId, "credential", input);
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

        const savedHostsNow = Effect.gen(function* () {
          const pending = yield* requests.get(
            agentId,
            "credential",
            checkedName,
          );

          return yield* savedHosts(
            input,
            yield* repository.get(agentId, checkedName),
            pending,
          );
        });

        // Checked first, then read again after the secret's slow save, so a save made meanwhile isn't overwritten.
        yield* savedHostsNow;

        if (input.secret)
          yield* secrets.save(
            credentialSecretKey(agentId, checkedName),
            input.secret,
          );

        const hosts = yield* savedHostsNow;

        const credential = yield* repository
          .save(agentId, checkedName, {
            hosts,
            github: false,
            placeholder: `crumble-credential-${randomBytes(24).toString("hex")}`,
          })
          .pipe(Effect.flatMap((record) => withSecret(agentId, record)));

        yield* requests.answer(
          agentId,
          "credential",
          checkedName,
          `The owner saved credential ${checkedName} for ${hostsText(credential.hosts)}. Coding jobs see it as $${checkedName}.`,
        );

        return credential;
      });

      const remove = Effect.fn("Credentials.delete")(function* (
        agentId: string,
        name: string,
      ) {
        if (yield* repository.delete(agentId, name)) {
          yield* secrets.delete(credentialSecretKey(agentId, name));

          return yield* useLog.forget(agentId, "credential", name);
        }

        if (!(yield* requests.decline(agentId, "credential", name)))
          return yield* new NotFound({ message: "Credential not found" });
      });

      const decline = Effect.fn("Credentials.decline")(function* (
        agentId: string,
        name: string,
      ) {
        if (!(yield* requests.decline(agentId, "credential", name)))
          return yield* new Conflict({
            message: "Credential request has already been answered",
          });
      });

      const uses = Effect.fn("Credentials.uses")(function* (
        agentId: string,
        name: string,
        options: { limit: number; before?: string | undefined },
      ) {
        if (!(yield* repository.get(agentId, name)))
          return yield* Effect.fail(
            new NotFound({ message: "Credential not found" }),
          );

        const listed = yield* useLog.list(agentId, "credential", name, options);

        return listed.map(({ detail, ...use }): CredentialUse => ({
          ...use,
          ...useDetail.parse(detail),
        }));
      });

      const env = Effect.fn("Credentials.env")(function* (agentId: string) {
        const placeholders = yield* repository.placeholders(agentId);
        const git = yield* githubApps.gitEnv(agentId);

        if (!Object.keys(placeholders).length) return git;

        return {
          ...git,
          ...placeholders,
          SSL_CERT_FILE: GUEST_CA_BUNDLE,
          // Debian's git uses GnuTLS, which ignores SSL_CERT_FILE.
          GIT_SSL_CAINFO: GUEST_CA_BUNDLE,
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
        githubIdentities: githubApps.identities,
        grants: repository.grants,
        value,
        recordUse: (agentId, name, { method, path, status, ...use }) =>
          useLog
            .record(agentId, "credential", name, {
              ...use,
              detail: { method, path, status },
            })
            .pipe(Effect.andThen(repository.touch(agentId, name, use.at))),
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
  githubIdentities(agentId: string): GitHubIdentity[];
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
    githubIdentities: (agentId) =>
      runtime.runSync(credentials.githubIdentities(agentId)),
    grants: (agentId) => runtime.runSync(credentials.grants(agentId)),
    value: (agentId, name, target) =>
      runtime.runPromise(
        credentials.value(agentId, name, target).pipe(
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

const githubLines = (identities: readonly GitHubIdentity[]) => {
  const [fallback, ...others] = identities;

  if (!fallback) return [];

  const reach = identities.map((each) =>
    each.account === null
      ? `every other repository ${each.name} can reach`
      : each.account,
  );

  return [
    `On GitHub you are ${fallback.name}: commits default to that author, and GH_TOKEN signs git and gh in for ${reach.join(", ")}.`,
    ...others.map(
      (each) =>
        `In a repository owned by ${each.account}, first run: git config user.name '${each.name}' && git config user.email '${each.email}'`,
    ),
    ...(others.length
      ? [
          `gh pr and other GraphQL commands use ${fallback.name}'s token; in ${others.map((each) => `${each.account}'s`).join(", ")} repositories use REST, such as gh api repos/OWNER/REPO/pulls -f title=... -f head=... -f base=...`,
        ]
      : []),
    ...identities.flatMap((each) =>
      each.trailer
        ? [
            `${each.name} is the owner's own account, which you act as in ${each.account}'s repositories: keep ${each.name} as the commit author, even if a task names an App's [bot] user, and mark your work instead: every commit there ends with the trailer "${each.trailer}". Repositories you clone add it on their own unless they set core.hooksPath; there, and in older clones, pass git commit --trailer '${each.trailer}'.`,
          ]
        : [],
    ),
  ];
};

/** What the bot and its coding jobs read about the bot's credentials and GitHub identity; undefined without either. */
export function workspaceCredentialSection(
  credentials: readonly AgentCredential[],
  identities: readonly GitHubIdentity[] = [],
) {
  if (!credentials.length && !identities.length) return undefined;

  return [
    ...(credentials.length
      ? [
          "Credentials the owner gave this bot, as environment variables in every command, with the hosts each works for:",
          ...credentialLines(credentials),
          "Each variable holds a placeholder. The workspace's HTTPS proxy replaces it with the real value in request headers, only on requests to its hosts; a placeholder in the URL or body is sent as it is. Use the variable as if it held the value, and never print it or write it into files. A client that ignores HTTPS_PROXY sends the placeholder and gets an authentication error: route it through the proxy instead.",
        ]
      : []),
    ...githubLines(identities),
  ].join("\n");
}

const pendingLines = (requests: readonly CredentialRequest[]) =>
  requests.length
    ? [
        "Credentials you asked for that the owner has not answered:",
        ...requests.map(
          (pending) => `- ${pending.name}: ${hostsText(pending.hosts)}`,
        ),
      ]
    : [];

/** What a bot names, for which hosts, and why, when it asks the owner for a secret. */
export const requestParameters = {
  name: Type.String({ minLength: 1, maxLength: MAX_CREDENTIAL_NAME_CHARS }),
  hosts: Type.Array(
    Type.String({ minLength: 1, maxLength: MAX_CREDENTIAL_HOST_CHARS }),
    {
      minItems: 1,
      maxItems: MAX_CREDENTIAL_HOSTS,
    },
  ),
  reason: Type.String({ minLength: 1, maxLength: MAX_REQUEST_REASON_CHARS }),
};

/** The bot's `request_credential` tool and the requests the owner has not answered, for bots with coding. */
export function credentialExtension(
  agentId: string,
  credentials: CredentialsAccess,
) {
  const request = defineTool({
    name: REQUEST_CREDENTIAL_TOOL_NAME,
    description:
      "Ask the owner for a credential your shell commands or coding jobs need, such as an API token for a service without an MCP server. Name it like an environment variable (ACME_TOKEN), list the hosts it is for (api.acme.com, *.acme.com), and say why. The owner enters the value outside the chat; you never see it. Your commands and coding jobs then get the variable with a placeholder that works only on requests to those hosts. After calling, tell the owner what you asked for and why, then end your turn: a message arrives when the owner answers.",
    parameters: Type.Object(requestParameters),
    // The chat offers the owner the form from this call's own result, so code mode keeps it a direct model tool.
    callers: ["model"],
    replay: "unsafe",
    execute: async (args) => {
      const request = credentials.request(
        agentId,
        credentialRequestInput.parse(args),
      );

      // Clients read the request from the details to offer the owner its form.
      return { ...toolOutput({ request }), details: request };
    },
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

import { errorText } from "../shared/errors";
import { createHash } from "node:crypto";
import {
  McpAuthRequiredError,
  McpClient,
  StreamableHttpTransport,
  toLlmContent,
  type AuthProvider,
  type CallToolResult,
  type McpRequestOptions,
  type McpTransport,
  type InitializeResult,
  type Tool,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { Type } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Agent } from "../contract/agents";
import type { MCPServer } from "./mcp-server-repository";
import { Context, Duration, Effect, Layer } from "effect";
import { AgentRepository } from "../bot-store/agent-repository";
import { Secrets, secretText } from "../secrets/secrets";
import type { ServerSecrets } from "../secrets/server-secrets";
import { mcpToolPrefix } from "../contract/tools";
import { runnerOf } from "../shared/runner";
import { McpServerRepository } from "./mcp-server-repository";
import { BotExtensions, ExtensionPosition } from "../bot-ports/bot-extensions";
import {
  type ClientDocument,
  connectionAuth,
  mcpTokenKey,
  hasOAuthTokens,
  secretStorage,
} from "./mcp-oauth";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";

export type MCPClient = {
  connect(transport: McpTransport): Promise<InitializeResult | void>;
  listTools(options?: McpRequestOptions): Promise<Tool[]>;
  callTool(
    name: string,
    args?: McpArguments,
    options?: McpRequestOptions,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
};

type McpArguments = Record<string, JsonValue>;

export type MCPClientFactory = (
  server: MCPServer,
  headers: Record<string, string>,
  authProvider?: AuthProvider,
) => { client: MCPClient; transport: McpTransport };

export type IntegrationsOptions = {
  requestTimeoutMs?: number;
  clientFactory?: MCPClientFactory;
  oauthClient?: ClientDocument | undefined;
};

const stable = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;

  if (!isJsonObject(value)) return JSON.stringify(value);

  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(value[k] ?? null)}`)
    .join(",")}}`;
};

const jsonObject = z.record(z.string(), z.json());

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return jsonObject.safeParse(value).success;
}

const digest = (value: JsonValue) =>
  createHash("sha256").update(stable(value)).digest("hex").slice(0, 24);

function defaultClientFactory(
  server: MCPServer,
  headers: Record<string, string>,
  authProvider?: AuthProvider,
) {
  const url = new URL(server.url);

  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`Unsupported MCP URL protocol: ${url.protocol}`);

  const transportOptions: ConstructorParameters<
    typeof StreamableHttpTransport
  >[0] = {
    url,
    headers,
    // Credentials never follow a redirect to another host.
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  };

  if (authProvider) transportOptions.authProvider = authProvider;

  const transport = new StreamableHttpTransport(transportOptions);

  return {
    client: new McpClient({ name: "crumble", version: "1.0.0" }),
    transport,
  };
}

const authFailure = (
  server: MCPServer,
  cause: unknown,
  authenticated: boolean,
) => {
  if (cause instanceof McpOAuthAuthorizationRequiredError)
    return new Error(
      `Sign in to ${server.name} again under Integrations to use its tools`,
    );

  if (cause instanceof McpAuthRequiredError)
    return new Error(
      authenticated
        ? `${server.name} rejected Crumble's credentials. Check its token, or sign in under Integrations`
        : `${server.name} needs a sign-in or token. Add one under Integrations to use its tools`,
    );

  return cause;
};

type OpenClient = { client: MCPClient; transport: McpTransport };

const closeConnection = (connection: OpenClient) =>
  Effect.promise(async () => {
    await connection.client.close().catch(() => undefined);
    await connection.transport.close().catch(() => undefined);
  });

const untilAborted = async <A>(
  call: Effect.Effect<A, unknown>,
  signal: AbortSignal | undefined,
) => {
  signal?.throwIfAborted();

  try {
    return await Effect.runPromise(call, signal ? { signal } : undefined);
  } catch (error) {
    signal?.throwIfAborted();

    throw error;
  }
};

export class McpIntegrations extends Context.Service<
  McpIntegrations,
  {
    readonly oauthClient: ClientDocument | undefined;
    /** Why a server's tools were left out of a bot's last turn, until it connects again. */
    readonly failure: (serverId: string) => string | null;
    readonly extensionsForAgent: (agent: Agent) => Promise<Extension[]>;
    readonly codemodeNamespaces: (agent: Agent) => CodemodeNamespace[];
    /** Drops a server's open connection, so the next use picks up a new token or sign-in. */
    readonly disconnect: (serverId: string) => Effect.Effect<void>;
  }
>()("crumble/integrations/McpIntegrations") {
  static layer(options: IntegrationsOptions = {}) {
    return Layer.effect(
      McpIntegrations,
      Effect.gen(function* () {
        const servers = yield* McpServerRepository;
        const agents = yield* AgentRepository;
        const secrets = yield* Secrets;

        const storage = secretStorage(
          runnerOf(yield* Effect.context<ServerSecrets | Secrets>()),
        );

        const timeout = options.requestTimeoutMs ?? 30_000;
        const factory = options.clientFactory ?? defaultClientFactory;
        const failures = new Map<string, string>();
        const disconnects = new Map<string, number>();

        const connections = new Map<
          string,
          OpenClient & { fingerprint: string }
        >();

        let closes = 0;

        const generation = (serverId: string) =>
          `${closes}:${disconnects.get(serverId) ?? 0}`;

        /** Bounds a call, including clients that ignore their signal and timeoutMs. */
        const timed = <A>(call: (signal: AbortSignal) => PromiseLike<A>) =>
          Effect.tryPromise({ try: call, catch: (cause) => cause }).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeout),
              orElse: () =>
                Effect.fail(
                  new Error(`MCP request timed out after ${timeout}ms`),
                ),
            }),
          );

        const token = (serverId: string) =>
          secretText(secrets)(mcpTokenKey(serverId)).pipe(
            Effect.mapError(
              (error) => new Error(`Token could not be read: ${error.message}`),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => failures.set(serverId, errorText(error))),
            ),
          );

        const authOf = Effect.fnUntraced(function* (server: MCPServer) {
          // A signed-in server authenticates through OAuth, which refreshes its own access token.
          const oauth = hasOAuthTokens(storage, server.id);
          const bearer = oauth ? undefined : yield* token(server.id);

          const headers: Record<string, string> = bearer
            ? { Authorization: `Bearer ${bearer}` }
            : {};

          return { oauth, headers, authenticated: oauth || Boolean(bearer) };
        });

        const connection = Effect.fnUntraced(function* (server: MCPServer) {
          const opening = generation(server.id);
          const { oauth, headers, authenticated } = yield* authOf(server);
          const fingerprint = digest({ url: server.url, headers, oauth });
          const existing = connections.get(server.id);

          if (existing?.fingerprint === fingerprint) return existing;

          if (existing) {
            yield* closeConnection(existing);
            connections.delete(server.id);
          }

          const authProvider = oauth
            ? yield* Effect.tryPromise({
                try: () => connectionAuth(storage, server, options.oauthClient),
                catch: (cause) => cause,
              })
            : undefined;

          const value = yield* Effect.try({
            try: () => factory(server, headers, authProvider),
            catch: (cause) => cause,
          });

          yield* timed(() => value.client.connect(value.transport)).pipe(
            Effect.onInterrupt(() => closeConnection(value)),
            Effect.catch((error) =>
              closeConnection(value).pipe(
                Effect.andThen(
                  Effect.fail(authFailure(server, error, authenticated)),
                ),
              ),
            ),
          );

          // A disconnect while this one opened means its sign-in may be stale.
          if (generation(server.id) !== opening) {
            yield* closeConnection(value);

            return yield* Effect.fail(
              new Error("MCP server credentials changed; retry this task"),
            );
          }

          const cached = { ...value, fingerprint };

          connections.set(server.id, cached);

          return cached;
        });

        const failure = (serverId: string) => failures.get(serverId) ?? null;

        const listedTools = (server: MCPServer) =>
          Effect.gen(function* () {
            const open = yield* connection(server);

            const listed = yield* timed(() =>
              open.client.listTools({ timeoutMs: timeout }),
            ).pipe(
              Effect.catch((error) =>
                Effect.sync(() => connections.delete(server.id)).pipe(
                  Effect.andThen(closeConnection(open)),
                  Effect.andThen(Effect.fail(authFailure(server, error, true))),
                ),
              ),
            );

            failures.delete(server.id);

            return listed;
          }).pipe(
            Effect.catch((error) =>
              Effect.sync((): Tool[] => {
                failures.set(server.id, errorText(error));

                return [];
              }),
            ),
          );

        /** One call of a remote tool. The durable tool is unsafe to replay, so a deadline reports the call and never retries it. */
        const callTool = (
          agent: Agent,
          server: MCPServer,
          remote: Tool,
          args: McpArguments,
        ) =>
          Effect.gen(function* () {
            const allowed = Effect.gen(function* () {
              const current = yield* servers.usable(agent.id, server.id);
              const owner = yield* agents.get(agent.id);

              if (
                !current ||
                !owner?.enabled ||
                !owner.mcpServers.includes(server.id)
              )
                return yield* Effect.fail(
                  new Error(
                    `MCP server ${server.name} is no longer enabled for this agent`,
                  ),
                );

              if (current.url !== server.url)
                return yield* Effect.fail(
                  new Error("MCP server address changed; retry this task"),
                );

              return current;
            });

            const open = yield* connection(yield* allowed);

            yield* allowed;

            const result = yield* timed((signal) =>
              open.client.callTool(remote.name, args, {
                signal,
                timeoutMs: timeout,
              }),
            ).pipe(
              Effect.mapError((error) => authFailure(server, error, true)),
            );

            const output = toLlmContent(result);

            return result.isError === undefined
              ? { output }
              : { output, isError: result.isError };
          });

        const toolOf = (agent: Agent, server: MCPServer, remote: Tool) =>
          defineTool({
            name: `${mcpToolPrefix(server.id)}${remote.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
            description:
              remote.description ?? `MCP tool ${remote.name} (${server.name})`,
            // Providers need an object schema, and some reject one without `properties`.
            parameters: Type.Unsafe<McpArguments>({
              ...remote.inputSchema,
              type: "object",
              properties: remote.inputSchema["properties"] ?? {},
            }),
            replay: "unsafe",
            execute: (args, _api, context) =>
              untilAborted(
                callTool(agent, server, remote, args),
                context.abortSignal,
              ),
          });

        const extensions = Effect.fnUntraced(function* (agent: Agent) {
          const tools: ToolRegistration[] = [];
          const connected: string[] = [];
          const leftOut: string[] = [];

          for (const serverId of agent.mcpServers) {
            const server = yield* servers.usable(agent.id, serverId);

            if (!server) continue;
            const listed = yield* listedTools(server);
            const reason = failure(server.id);

            if (reason) leftOut.push(`- ${server.name}: ${reason}`);
            else
              connected.push(
                `- ${server.name}: ${listed.length} tools named ${mcpToolPrefix(server.id)}*`,
              );

            for (const remote of listed)
              tools.push(toolOf(agent, server, remote));
          }

          const summary = [
            connected.length
              ? `MCP servers the owner connected, with their tools:\n${connected.join("\n")}`
              : "",
            leftOut.length
              ? `MCP servers left out of this turn; tell the owner why if they ask for them:\n${leftOut.join("\n")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n");

          return [
            defineExtension({
              name: `mcp:${agent.id}`,
              tools,
              sections: [
                { key: "mcp_servers", render: () => summary || undefined },
              ],
            }),
          ];
        });

        const disconnect = (serverId: string) =>
          Effect.gen(function* () {
            disconnects.set(serverId, (disconnects.get(serverId) ?? 0) + 1);
            const existing = connections.get(serverId);

            connections.delete(serverId);
            failures.delete(serverId);

            if (existing) yield* closeConnection(existing);
          });

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closes++;
            const open = [...connections.values()];

            connections.clear();
            yield* Effect.forEach(open, closeConnection, {
              concurrency: "unbounded",
              discard: true,
            });
          }),
        );

        return McpIntegrations.of({
          oauthClient: options.oauthClient,
          failure,
          extensionsForAgent: (agent) => Effect.runPromise(extensions(agent)),
          codemodeNamespaces: (agent) =>
            agent.mcpServers.flatMap((serverId) => {
              const server = Effect.runSync(servers.usable(agent.id, serverId));

              return server
                ? [
                    {
                      name: server.name,
                      description: `Tools of the ${server.name} MCP server`,
                      prefix: mcpToolPrefix(server.id),
                    },
                  ]
                : [];
            }),
          disconnect,
        });
      }),
    );
  }
}

export const integrationTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const integrations = yield* McpIntegrations;

    yield* (yield* BotExtensions).register(
      ExtensionPosition.integrations,
      (agent) => integrations.extensionsForAgent(agent),
    );
  }),
);

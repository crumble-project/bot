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
import type { Context as PiContext } from "@earendil-works/chord/context";
import type { Agent, MCPServer } from "../shared/domain";
import { Context, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { AgentRepository } from "../bots/agent-repository";
import { SecretRepository } from "../credentials/secret-repository";
import { SecretValues } from "../password-managers/secret-values";
import { runnerOf, type Runner } from "../shared/runner";
import { McpServerRepository } from "./mcp-server-repository";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import {
  type ClientDocument,
  connectionAuth,
  hasOAuthTokens,
  secretStorage,
  type SecretStorage,
} from "./mcp-oauth";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";

/** The part of pi-mcp's `McpClient` Crumble uses, so tests can stand in for a server. */
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
  /** The server's OAuth client metadata document, when it has a public address. */
  oauthClient?: ClientDocument | undefined;
};

/** Every tool of one MCP server starts with this, which also groups them in code mode. */
export const mcpToolPrefix = (serverId: string) =>
  `mcp_${serverId.replaceAll("-", "").slice(0, 8)}_`;

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

/** Turns an authentication failure into what the owner should do about it. */
function throwAuthFailure(
  server: MCPServer,
  cause: unknown,
  hadCredentials: boolean,
): never {
  if (cause instanceof McpOAuthAuthorizationRequiredError)
    throw new Error(
      `Sign in to ${server.name} again under Integrations to use its tools`,
    );

  if (cause instanceof McpAuthRequiredError)
    throw new Error(
      hadCredentials
        ? `${server.name} rejected Crumble's credentials. Check its token, or sign in under Integrations`
        : `${server.name} needs a sign-in or token. Add one under Integrations to use its tools`,
    );

  throw cause;
}

type CredentialHeaders = { readonly [header: string]: string };

const credentialPayload = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  token: z.string().optional(),
});

function credentials(raw: string | undefined) {
  if (!raw) return {};

  try {
    const parsed = credentialPayload.safeParse(JSON.parse(raw));

    if (parsed.success) {
      if (parsed.data.headers)
        return { ...parsed.data.headers } satisfies CredentialHeaders;

      if (parsed.data.token)
        return {
          Authorization: `Bearer ${parsed.data.token}`,
        } satisfies CredentialHeaders;
    }
  } catch {
    /* Treat a legacy credential as a bearer token. */
  }

  return { Authorization: `Bearer ${raw}` } satisfies CredentialHeaders;
}

/** What connections read from the account: the servers a bot may use, its bots, and their secrets. */
type IntegrationData = {
  usableServer(agentId: string, serverId: string): MCPServer | null;
  agent(agentId: string): Agent | null;
  secrets: SecretStorage;
  /** The server's token, read from its password manager when it is a reference. */
  token(serverId: string): Promise<string | undefined>;
};

type IntegrationServices =
  | McpServerRepository
  | AgentRepository
  | SecretRepository
  | SecretValues;

const tokenOf = (serverId: string) =>
  Effect.gen(function* () {
    const source = yield* SecretRepository.use((r) =>
      r.source(`mcp:${serverId}`),
    );

    if (!source) return undefined;

    return Redacted.value(
      yield* SecretValues.use((values) => values.read(source)),
    );
  }).pipe(
    // Shown as the server's failure under Integrations, after its name.
    Effect.mapError(
      (error) => new Error(`Token could not be read: ${error.message}`),
    ),
  );

class McpConnections {
  private readonly failures = new Map<string, string>();
  private readonly disconnects = new Map<string, number>();
  private closes = 0;
  private readonly connections = new Map<
    string,
    {
      fingerprint: string;
      client: MCPClient;
      transport: McpTransport;
    }
  >();
  private readonly timeout: number;
  private readonly factory: MCPClientFactory;
  constructor(
    private readonly data: IntegrationData,
    options: IntegrationsOptions = {},
  ) {
    this.timeout = options.requestTimeoutMs ?? 30_000;
    this.factory = options.clientFactory ?? defaultClientFactory;
    this.oauthClient = options.oauthClient;
  }

  private readonly oauthClient: ClientDocument | undefined;

  private async withTimeout<T>(
    promise: Promise<T>,
    ms = this.timeout,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MCP request timed out after ${ms}ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Bound the whole MCP call, including clients that ignore timeoutMs. The durable
   * tool is unsafe to replay, so a deadline only aborts and reports the one call;
   * it must never transparently retry it.
   */
  private async callToolWithTimeout(
    client: MCPClient,
    name: string,
    args: McpArguments,
    parent: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    const controller = new AbortController();

    const parentReason = () =>
      parent?.reason ?? new Error("MCP request aborted");

    let parentAbortReject: ((cause: unknown) => void) | undefined;

    const parentAborted = new Promise<CallToolResult>((_, reject) => {
      parentAbortReject = reject;
    });

    const abortFromParent = () => {
      const reason = parentReason();
      controller.abort(reason);
      parentAbortReject?.(reason);
    };

    if (parent?.aborted) {
      parent.throwIfAborted();
    } else parent?.addEventListener("abort", abortFromParent, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ((cause: unknown) => void) | undefined;

    const deadlineReached = new Promise<CallToolResult>((_, reject) => {
      deadline = (reason) => reject(reason);
      timer = setTimeout(() => {
        const error = new Error(
          `MCP request timed out after ${this.timeout}ms`,
        );

        controller.abort(error);
        deadline?.(error);
      }, this.timeout);
    });

    try {
      const call = client.callTool(name, args, {
        signal: controller.signal,
        timeoutMs: this.timeout,
      });

      return await Promise.race([call, deadlineReached, parentAborted]);
    } finally {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    }
  }

  // Kept as the server's failure even when a tool call reads it, since the token can become unreadable after listing.
  private async token(serverId: string) {
    try {
      return await this.data.token(serverId);
    } catch (error) {
      this.failures.set(
        serverId,
        error instanceof Error ? error.message : String(error),
      );

      throw error;
    }
  }

  private async connection(server: MCPServer) {
    const generation = this.generation(server.id);
    // A signed-in server authenticates through OAuth, which refreshes its own access token.
    const oauth = hasOAuthTokens(this.data.secrets, server.id);

    const headers = oauth ? {} : credentials(await this.token(server.id));

    const hadCredentials = oauth || Object.keys(headers).length > 0;
    const fingerprint = digest({ url: server.url, headers, oauth });
    const existing = this.connections.get(server.id);

    if (existing?.fingerprint === fingerprint) return existing;

    if (existing) {
      await existing.client.close().catch(() => undefined);
      await existing.transport.close().catch(() => undefined);
      this.connections.delete(server.id);
    }

    const value = this.factory(
      server,
      headers,
      oauth
        ? connectionAuth(this.data.secrets, server, this.oauthClient)
        : undefined,
    );

    try {
      await this.withTimeout(value.client.connect(value.transport));
    } catch (error) {
      await value.client.close().catch(() => undefined);
      await value.transport.close().catch(() => undefined);
      throwAuthFailure(server, error, hadCredentials);
    }

    // A disconnect while this one opened means its credentials may be stale.
    if (this.generation(server.id) !== generation) {
      await value.client.close().catch(() => undefined);
      await value.transport.close().catch(() => undefined);
      throw new Error("MCP server credentials changed; retry this task");
    }

    const cached = { ...value, fingerprint };
    this.connections.set(server.id, cached);

    return cached;
  }

  private generation(serverId: string) {
    return `${this.closes}:${this.disconnects.get(serverId) ?? 0}`;
  }

  /** Why a server's tools were left out of a bot's last turn, until it connects again. */
  failure(serverId: string) {
    return this.failures.get(serverId) ?? null;
  }

  /** Connects and lists a server's tools; a server that fails is skipped and its reason kept, so the bot still answers. */
  private async listedTools(server: MCPServer) {
    try {
      const connection = await this.connection(server);

      const listed = await this.withTimeout(
        connection.client.listTools({ timeoutMs: this.timeout }),
      ).catch(async (error) => {
        this.connections.delete(server.id);
        await connection.client.close().catch(() => undefined);
        throwAuthFailure(server, error, true);
      });

      this.failures.delete(server.id);

      return listed;
    } catch (error) {
      this.failures.set(
        server.id,
        error instanceof Error ? error.message : String(error),
      );

      return [];
    }
  }

  async extensionsForAgent(agent: Agent) {
    const tools: ToolRegistration[] = [];
    const connected: string[] = [];
    const leftOut: string[] = [];

    for (const serverId of agent.mcpServers) {
      const server = this.data.usableServer(agent.id, serverId);

      if (!server) continue;
      const listed = await this.listedTools(server);
      const failure = this.failure(server.id);

      if (failure) leftOut.push(`- ${server.name}: ${failure}`);
      else
        connected.push(
          `- ${server.name}: ${listed.length} tools named ${mcpToolPrefix(server.id)}*`,
        );

      for (const remote of listed) {
        const name = `${mcpToolPrefix(server.id)}${remote.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;

        const tool = defineTool({
          name,
          description:
            remote.description ?? `MCP tool ${remote.name} (${server.name})`,
          // Providers need an object schema, and some reject one without `properties`.
          parameters: Type.Unsafe({
            ...remote.inputSchema,
            type: "object",
            properties: remote.inputSchema["properties"] ?? {},
          }),
          replay: "unsafe",
          execute: async (
            args: McpArguments,
            _api: any,
            context: PiContext,
          ) => {
            const assertAllowed = () => {
              const current = this.data.usableServer(agent.id, server.id);
              const owner = this.data.agent(agent.id);

              if (
                !current ||
                !owner?.enabled ||
                !owner.mcpServers.includes(server.id)
              )
                throw new Error(
                  `MCP server ${server.name} is no longer enabled for this agent`,
                );

              if (current.url !== server.url)
                throw new Error("MCP server address changed; retry this task");

              return current;
            };

            const currentServer = assertAllowed();
            const activeConnection = await this.connection(currentServer);
            assertAllowed();
            const signal = context.abortSignal;

            const result = await this.callToolWithTimeout(
              activeConnection.client,
              remote.name,
              args,
              signal,
            ).catch((error) => {
              throwAuthFailure(server, error, true);
            });

            const output = toLlmContent(result);

            return result.isError === undefined
              ? { output }
              : { output, isError: result.isError };
          },
        });

        tools.push(tool);
      }
    }

    // Tool names carry a server ID, not its name, so the bot learns which integration each belongs to here.
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
        sections: [{ key: "mcp_servers", render: () => summary || undefined }],
      }),
    ];
  }

  /** The agent's MCP servers as code mode namespaces, so scripts see each server's tools together. */
  codemodeNamespaces(agent: Agent): CodemodeNamespace[] {
    return agent.mcpServers.flatMap((serverId) => {
      const server = this.data.usableServer(agent.id, serverId);

      return server
        ? [
            {
              name: server.name,
              description: `Tools of the ${server.name} MCP server`,
              prefix: mcpToolPrefix(server.id),
            },
          ]
        : [];
    });
  }

  /** Drops a server's open connection, so the next use picks up new credentials. */
  async disconnect(serverId: string) {
    this.disconnects.set(serverId, (this.disconnects.get(serverId) ?? 0) + 1);
    const existing = this.connections.get(serverId);
    this.connections.delete(serverId);
    this.failures.delete(serverId);
    await existing?.client.close().catch(() => undefined);
    await existing?.transport.close().catch(() => undefined);
  }

  async close() {
    this.closes++;
    const values = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(
      values.map(async ({ client, transport }) => {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }),
    );
  }
}

export type { Agent };

/** The account's MCP servers as tools for bots: connections stay open and close with the account. */
export class McpIntegrations extends Context.Service<
  McpIntegrations,
  {
    /** Why a server's tools were left out of a bot's last turn, until it connects again. */
    readonly failure: (serverId: string) => string | null;
    /** The bot's MCP tools, for Pi Durable at turn time. */
    readonly extensionsForAgent: (agent: Agent) => Promise<Extension[]>;
    /** The agent's MCP servers as code mode namespaces, so scripts see each server's tools together. */
    readonly codemodeNamespaces: (agent: Agent) => CodemodeNamespace[];
    /** Drops a server's open connection, so the next use picks up new credentials. */
    readonly disconnect: (serverId: string) => Effect.Effect<void>;
  }
>()("crumble/integrations/McpIntegrations") {
  static layer(options: IntegrationsOptions = {}) {
    return Layer.effect(
      McpIntegrations,
      Effect.gen(function* () {
        const run = runnerOf(yield* Effect.context<IntegrationServices>());

        const connections = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new McpConnections(
                {
                  usableServer: (agentId, serverId) =>
                    run.runSync(
                      McpServerRepository.use((servers) =>
                        servers.usable(agentId, serverId),
                      ),
                    ),
                  agent: (agentId) =>
                    run.runSync(
                      AgentRepository.use((agents) => agents.get(agentId)),
                    ),
                  secrets: secretStorage(run),
                  token: (serverId) => run.runPromise(tokenOf(serverId)),
                },
                options,
              ),
          ),
          (open) => Effect.promise(() => open.close()),
        );

        return McpIntegrations.of({
          failure: (serverId) => connections.failure(serverId),
          extensionsForAgent: (agent) => connections.extensionsForAgent(agent),
          codemodeNamespaces: (agent) => connections.codemodeNamespaces(agent),
          disconnect: (serverId) =>
            Effect.promise(() => connections.disconnect(serverId)),
        });
      }),
    );
  }
}

/** MCP integrations over the data `core` reaches, for an API or a test that runs without an account. */
export function standaloneIntegrations(
  core: Runner<IntegrationServices>,
  options: IntegrationsOptions = {},
) {
  const runtime = ManagedRuntime.make(
    McpIntegrations.layer(options).pipe(
      Layer.provide(
        Layer.succeedContext(
          core.runSync(Effect.context<IntegrationServices>()),
        ),
      ),
    ),
  );

  return {
    integrations: runtime.runSync(McpIntegrations.use(Effect.succeed)),
    close: () => runtime.dispose(),
  };
}

/** Offers each bot the tools of the MCP servers it may use. */
export const integrationTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const integrations = yield* McpIntegrations;

    yield* (yield* BotExtensions).register(
      ExtensionPosition.integrations,
      (agent) => integrations.extensionsForAgent(agent),
    );
  }),
);

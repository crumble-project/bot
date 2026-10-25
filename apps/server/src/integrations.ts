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
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { Agent, MCPServer } from "./domain";
import { Store } from "./store";
import {
  type ClientDocument,
  connectionAuth,
  hasOAuthTokens,
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
  oauthClient?: ClientDocument;
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

function credentials(store: Store, server: MCPServer) {
  const raw = store.getCredential(`mcp:${server.id}`);

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

export class MCPIntegrations {
  private readonly failures = new Map<string, string>();
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
    private readonly store: Store,
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

  private async connection(server: MCPServer) {
    // A signed-in server authenticates through OAuth, which refreshes its own access token.
    const oauth = hasOAuthTokens(this.store, server.id);
    const headers = oauth ? {} : credentials(this.store, server);
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
      oauth ? connectionAuth(this.store, server, this.oauthClient) : undefined,
    );

    try {
      await this.withTimeout(value.client.connect(value.transport));
      const cached = { ...value, fingerprint };
      this.connections.set(server.id, cached);

      return cached;
    } catch (error) {
      await value.client.close().catch(() => undefined);
      await value.transport.close().catch(() => undefined);
      throwAuthFailure(server, error, hadCredentials);
    }
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
      const server = this.store.usableMCPServer(agent.id, serverId);

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
            properties: remote.inputSchema.properties ?? {},
          }),
          replay: "unsafe",
          execute: async (args: McpArguments, _api: any, context: Context) => {
            const assertAllowed = () => {
              const current = this.store.usableMCPServer(agent.id, server.id);
              const owner = this.store.getAgent(agent.id);

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

            return { output: toLlmContent(result), isError: result.isError };
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
      const server = this.store.usableMCPServer(agent.id, serverId);

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
    const existing = this.connections.get(serverId);
    this.connections.delete(serverId);
    this.failures.delete(serverId);
    await existing?.client.close().catch(() => undefined);
    await existing?.transport.close().catch(() => undefined);
  }

  async close() {
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

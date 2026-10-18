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
  type Tool,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { Agent, MCPServer } from "./domain";
import { Store } from "./store";
import { connectionAuth, hasOAuthTokens } from "./mcp-oauth";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";

/** The part of pi-mcp's `McpClient` Crumble uses, so tests can stand in for a server. */
export type MCPClient = {
  connect(transport: McpTransport): Promise<unknown>;
  listTools(options?: McpRequestOptions): Promise<Tool[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
};

export type MCPClientFactory = (
  server: MCPServer,
  headers: Record<string, string>,
  authProvider?: AuthProvider,
) => { client: MCPClient; transport: McpTransport };
export type IntegrationsOptions = {
  requestTimeoutMs?: number;
  clientFactory?: MCPClientFactory;
};

/** Every tool of one MCP server starts with this, which also groups them in code mode. */
export const mcpToolPrefix = (serverId: string) =>
  `mcp_${serverId.replaceAll("-", "").slice(0, 8)}_`;
const now = () => new Date().toISOString();
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
};
const digest = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex").slice(0, 24);

function defaultClientFactory(
  server: MCPServer,
  headers: Record<string, string>,
  authProvider?: AuthProvider,
) {
  const url = new URL(server.url);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`Unsupported MCP URL protocol: ${url.protocol}`);
  const transport = new StreamableHttpTransport({
    url,
    headers,
    ...(authProvider ? { authProvider } : {}),
    // Credentials never follow a redirect to another host.
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
  return {
    client: new McpClient({ name: "crumble", version: "1.0.0" }),
    transport,
  };
}

/** Turns an authentication failure into what the owner should do about it. */
function explainAuthFailure(server: MCPServer, error: unknown): unknown {
  if (error instanceof McpOAuthAuthorizationRequiredError)
    return new Error(
      `Sign in to ${server.name} again under Integrations to use its tools`,
    );
  if (error instanceof McpAuthRequiredError)
    return new Error(
      `${server.name} rejected Crumble's credentials. Check its token, or sign in under Integrations`,
    );
  return error;
}

function credentials(store: Store, server: MCPServer): Record<string, string> {
  const raw = store.getCredential(`mcp:${server.id}`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      headers?: Record<string, string>;
      token?: string;
    };
    if (parsed.headers) return { ...parsed.headers };
    if (parsed.token) return { Authorization: `Bearer ${parsed.token}` };
  } catch {
    /* Treat a legacy credential as a bearer token. */
  }
  return { Authorization: `Bearer ${raw}` };
}

export class MCPIntegrations {
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
  }

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
    args: Record<string, unknown>,
    parent: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    const controller = new AbortController();
    const parentReason = () =>
      parent?.reason ?? new Error("MCP request aborted");
    let parentAbortReject: ((reason: unknown) => void) | undefined;
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
    let deadline: ((reason: Error) => void) | undefined;
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
      oauth ? connectionAuth(this.store, server) : undefined,
    );
    try {
      await this.withTimeout(value.client.connect(value.transport));
      const cached = { ...value, fingerprint };
      this.connections.set(server.id, cached);
      return cached;
    } catch (error) {
      await value.client.close().catch(() => undefined);
      await value.transport.close().catch(() => undefined);
      throw explainAuthFailure(server, error);
    }
  }

  async extensionsForAgent(agent: Agent) {
    const tools: ToolRegistration[] = [];
    for (const serverId of agent.mcpServers) {
      const server = this.store.usableMCPServer(agent.id, serverId);
      if (!server) continue;
      const connection = await this.connection(server);
      const listed = await this.withTimeout(
        connection.client.listTools({ timeoutMs: this.timeout }),
      ).catch(async (error) => {
        this.connections.delete(server.id);
        await connection.client.close().catch(() => undefined);
        throw explainAuthFailure(server, error);
      });
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
          execute: async (
            args: Record<string, unknown>,
            _api: any,
            context: Context,
          ) => {
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
              throw explainAuthFailure(server, error);
            });
            return { output: toLlmContent(result), isError: result.isError };
          },
        });
        tools.push(tool);
      }
    }
    return [defineExtension({ name: `mcp:${agent.id}`, tools })];
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

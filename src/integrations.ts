import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { Agent, MCPServer } from "./domain";
import { Store } from "./store";
import { conversationReference } from "./runtime";

export type ApprovalStatus = "pending" | "approved" | "denied";
export type ApprovalRecord = {
  id: string;
  agentId: string;
  conversationId: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  taskId: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
};

export type MCPClient = {
  connect(transport: unknown, options?: unknown): Promise<void>;
  listTools(params?: unknown, options?: unknown): Promise<{ tools: MCPTool[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<MCPResult>;
  close(): Promise<void>;
};
export type MCPTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
};
export type MCPResult = {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
};

export type MCPClientFactory = (
  server: MCPServer,
  headers: Record<string, string>,
) => { client: MCPClient; transport: { close?: () => Promise<void> } };
export type IntegrationsOptions = {
  requestTimeoutMs?: number;
  clientFactory?: MCPClientFactory;
};

const approvalsKey = "mcp.approvals";
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

/** Durable approval state. Pending decisions survive a process restart in Store settings. */
export class ApprovalManager {
  private readonly waiters = new Map<
    string,
    Set<(status: ApprovalStatus) => void>
  >();
  constructor(private readonly store: Store) {}

  list(agentId?: string): ApprovalRecord[] {
    const records = this.store.getSetting<ApprovalRecord[]>(approvalsKey) ?? [];
    return agentId ? records.filter((r) => r.agentId === agentId) : records;
  }

  private save(records: ApprovalRecord[]) {
    this.store.setSetting(approvalsKey, records);
  }

  request(
    input: Omit<ApprovalRecord, "id" | "status" | "createdAt" | "updatedAt">,
  ): ApprovalRecord {
    const existing = this.list().find(
      (r) =>
        r.taskId === input.taskId &&
        r.agentId === input.agentId &&
        r.serverId === input.serverId &&
        r.toolName === input.toolName &&
        stable(r.arguments) === stable(input.arguments),
    );
    if (existing) return existing;
    const t = now();
    const record: ApprovalRecord = {
      ...input,
      id: digest({
        agentId: input.agentId,
        conversationId: input.conversationId,
        serverId: input.serverId,
        toolName: input.toolName,
        arguments: input.arguments,
        taskId: input.taskId,
      }),
      status: "pending",
      createdAt: t,
      updatedAt: t,
    };
    this.save([...this.list(), record]);
    return record;
  }

  decide(
    id: string,
    status: Exclude<ApprovalStatus, "pending">,
  ): ApprovalRecord | undefined {
    const records = this.list();
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) return undefined;
    const current = records[index]!;
    if (current.status !== "pending") return current;
    const updated = { ...current, status, updatedAt: now() };
    records[index] = updated;
    this.save(records);
    for (const resolve of this.waiters.get(id) ?? []) resolve(status);
    this.waiters.delete(id);
    return updated;
  }

  async wait(
    record: ApprovalRecord,
    context: Context,
  ): Promise<Exclude<ApprovalStatus, "pending">> {
    const latest = this.list().find((item) => item.id === record.id);
    if (latest?.status !== "pending")
      return (latest?.status ?? record.status) as Exclude<
        ApprovalStatus,
        "pending"
      >;
    const status = await new Promise<ApprovalStatus>((resolve, reject) => {
      const listeners = this.waiters.get(record.id) ?? new Set();
      const completed = (value: ApprovalStatus) => {
        cleanup();
        resolve(value);
      };
      listeners.add(completed);
      this.waiters.set(record.id, listeners);
      const signal = context.abortSignal;
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        listeners.delete(completed);
        if (!listeners.size) this.waiters.delete(record.id);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("approval wait cancelled"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const decided = this.list().find((item) => item.id === record.id);
      if (decided?.status !== "pending") {
        cleanup();
        resolve(decided?.status ?? "denied");
      }
    });
    if (status === "pending") throw new Error("approval remained pending");
    return status;
  }
}

function defaultClientFactory(
  server: MCPServer,
  headers: Record<string, string>,
) {
  const url = new URL(server.url);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`Unsupported MCP URL protocol: ${url.protocol}`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers, redirect: "error" },
  });
  const client = new Client({
    name: "crumble",
    version: "1.0.0",
  }) as unknown as MCPClient;
  return { client, transport };
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

function output(
  result: MCPResult,
): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  if (result.content?.length)
    return result.content.map((item) => {
      if (
        item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string"
      )
        return {
          type: "image" as const,
          data: item.data,
          mimeType: item.mimeType,
        };
      if (item.type === "text" && typeof item.text === "string")
        return { type: "text" as const, text: item.text };
      return { type: "text" as const, text: JSON.stringify(item) };
    });
  if (result.structuredContent !== undefined)
    return [{ type: "text", text: JSON.stringify(result.structuredContent) }];
  return [{ type: "text", text: "" }];
}

export class MCPIntegrations {
  private readonly connections = new Map<
    string,
    {
      fingerprint: string;
      client: MCPClient;
      transport: { close?: () => Promise<void> };
    }
  >();
  private readonly timeout: number;
  private readonly factory: MCPClientFactory;
  readonly approvals: ApprovalManager;
  constructor(
    private readonly store: Store,
    options: IntegrationsOptions = {},
  ) {
    this.timeout = options.requestTimeoutMs ?? 30_000;
    this.factory = options.clientFactory ?? defaultClientFactory;
    this.approvals = new ApprovalManager(store);
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

  private async connection(server: MCPServer) {
    const headers = credentials(this.store, server);
    const fingerprint = digest({ url: server.url, headers });
    const existing = this.connections.get(server.id);
    if (existing?.fingerprint === fingerprint) return existing;
    if (existing) {
      await existing.client.close().catch(() => undefined);
      await existing.transport.close?.().catch(() => undefined);
      this.connections.delete(server.id);
    }
    const value = this.factory(server, headers);
    try {
      await this.withTimeout(value.client.connect(value.transport));
      const cached = { ...value, fingerprint };
      this.connections.set(server.id, cached);
      return cached;
    } catch (error) {
      await value.client.close().catch(() => undefined);
      await value.transport.close?.().catch(() => undefined);
      throw error;
    }
  }

  async extensionsForAgent(agent: Agent) {
    const tools: ToolRegistration[] = [];
    for (const serverId of agent.mcpServers) {
      const server = this.store.getMCPServer(serverId);
      if (!server?.enabled) continue;
      const connection = await this.connection(server);
      const listed = await this.withTimeout(
        connection.client.listTools(undefined, { timeout: this.timeout }),
      ).catch(async (error) => {
        this.connections.delete(server.id);
        await connection.client.close().catch(() => undefined);
        throw error;
      });
      for (const remote of listed.tools) {
        const name = `mcp_${server.id.replaceAll("-", "").slice(0, 8)}_${remote.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        const destructive = remote.annotations?.readOnlyHint !== true;
        const tool = defineTool({
          name,
          description:
            remote.description ?? `MCP tool ${remote.name} (${server.name})`,
          parameters: Type.Unsafe(remote.inputSchema as any),
          replay: "unsafe",
          execute: async (
            args: Record<string, unknown>,
            api: any,
            context: Context,
          ) => {
            const assertAllowed = () => {
              const current = this.store.getMCPServer(server.id);
              const owner = this.store.getAgent(agent.id);
              if (
                !current?.enabled ||
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
            assertAllowed();
            if (destructive) {
              const record = this.approvals.request({
                agentId: agent.id,
                conversationId: conversationReference(
                  agent.id,
                  Number(api.conversationId),
                ),
                serverId: server.id,
                toolName: remote.name,
                arguments: args,
                taskId: String(api.taskId),
              });
              const status = await this.approvals.wait(record, context);
              if (status === "denied")
                throw new Error(`MCP tool ${remote.name} was denied`);
            }
            const currentServer = assertAllowed();
            const activeConnection = await this.connection(currentServer);
            const signal = context.abortSignal;
            const result = await activeConnection.client.callTool(
              { name: remote.name, arguments: args },
              undefined,
              { signal, timeout: this.timeout },
            );
            return { output: output(result), isError: result.isError };
          },
        });
        tools.push(tool);
      }
    }
    return [defineExtension({ name: `mcp:${agent.id}`, tools })];
  }

  async close() {
    const values = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(
      values.map(async ({ client, transport }) => {
        await client.close().catch(() => undefined);
        await transport.close?.().catch(() => undefined);
      }),
    );
  }
}

export type { Agent };

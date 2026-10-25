import { describe, expect, test } from "bun:test";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Agent, MCPServer } from "../shared/domain";
import {
  mcpToolPrefix,
  standaloneIntegrations,
  type MCPClient,
} from "./integrations";
import { Store } from "../../test/support/store";
import type { McpTransport } from "@earendil-works/pi-mcp";

const agent = (id: string, mcpServers: string[]): Agent => ({
  id,
  name: "worker",
  avatar: "sparkles",
  description: "",
  instructions: "",
  provider: "openai",
  model: "test",
  enabled: true,
  tools: [],
  skills: [],
  mcpServers,
  delegates: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/** The fake clients never use their transport. */
// SAFETY: The fake clients only require the transport close method.
const unusedTransport = { close: async () => {} } as McpTransport;

function tempDir() {
  return Bun.$`mktemp -d`.text();
}

describe("MCP integrations", () => {
  test("only loads enabled servers explicitly allowed by the agent and maps schemas", async () => {
    const dir = (await tempDir()).trim();
    const store = new Store(dir);

    const server = store.createMCPServer({
      name: "demo",
      url: "https://mcp.example.test",
      enabled: true,
    });

    let called = 0;

    const client: MCPClient = {
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        called++;

        return { content: [{ type: "text", text: "ok" }] };
      },
    };

    const { integrations, close } = standaloneIntegrations(store.runtime, {
      clientFactory: () => ({ client, transport: unusedTransport }),
    });

    const agentId = "00000000-0000-4000-8000-000000000001";

    const extensions = await integrations.extensionsForAgent(
      store.createAgent(agent(agentId, [server.id]), agentId),
    );

    expect(extensions).toHaveLength(1);
    const first = extensions[0];

    if (!first) throw new Error("missing extension");
    // SAFETY: MCP extensions expose their registered tool list.
    const tools = (first as any).tools as any[];
    expect(tools).toHaveLength(1);
    const tool: any = tools[0];

    if (!tool) throw new Error("missing tool");

    const result = await tool.execute(
      { text: "hi" },
      { taskId: "task-read", conversationId: "conversation-a" },
      BACKGROUND_CONTEXT,
    );

    // SAFETY: The fake MCP client returns text output items.
    expect((result.output as any)[0].text).toBe("ok");
    expect(called).toBe(1);
    await close();
    store.close();
  });

  test("groups each enabled server's tools for code mode", async () => {
    const store = new Store((await tempDir()).trim());

    const linear = store.createMCPServer({
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      enabled: true,
    });

    const off = store.createMCPServer({
      name: "Off",
      url: "https://off.example.test",
      enabled: false,
    });

    const { integrations, close } = standaloneIntegrations(store.runtime);

    const namespaces = integrations.codemodeNamespaces(
      agent("a1", [linear.id, off.id]),
    );

    expect(namespaces).toEqual([
      {
        name: "Linear",
        description: "Tools of the Linear MCP server",
        prefix: mcpToolPrefix(linear.id),
      },
    ]);
    await close();
    store.close();
  });

  test("executes side-effect tools directly after the final permission check", async () => {
    const dir = (await tempDir()).trim();
    const store = new Store(dir);

    const server: MCPServer = store.createMCPServer({
      name: "demo",
      url: "https://mcp.example.test",
      enabled: true,
    });

    let called = 0;

    const client: MCPClient = {
      async connect() {},
      async close() {},
      async listTools() {
        return [{ name: "send", inputSchema: { type: "object" } }];
      },
      async callTool() {
        called++;

        return { content: [{ type: "text", text: "sent" }] };
      },
    };

    const { integrations, close } = standaloneIntegrations(store.runtime, {
      clientFactory: () => ({ client, transport: unusedTransport }),
    });

    const agentId = "00000000-0000-4000-8000-000000000002";

    const [extension] = await integrations.extensionsForAgent(
      store.createAgent(agent(agentId, [server.id]), agentId),
    );

    if (!extension) throw new Error("missing extension");
    // SAFETY: MCP extensions expose their registered tool list.
    const tools = (extension as any).tools as any[];
    const tool: any = tools[0];

    if (!tool) throw new Error("missing tool");

    const result = await tool.execute(
      { to: "user@example.test" },
      { taskId: "durable-task-1", conversationId: "conversation-a" },
      BACKGROUND_CONTEXT,
    );

    // SAFETY: The fake MCP client returns text output items.
    expect((result.output as any)[0].text).toBe("sent");
    expect(called).toBe(1);
    await close();
    store.close();
  });

  test("bounds a client that ignores timeoutMs", async () => {
    const dir = (await tempDir()).trim();
    const store = new Store(dir);

    const server = store.createMCPServer({
      name: "hung",
      url: "https://mcp.example.test",
      enabled: true,
    });

    const { integrations, close } = standaloneIntegrations(store.runtime, {
      requestTimeoutMs: 20,
      clientFactory: () => ({
        transport: unusedTransport,
        client: {
          async connect() {},
          async close() {},
          async listTools() {
            return [{ name: "hang", inputSchema: { type: "object" } }];
          },
          async callTool() {
            return await new Promise<never>(() => {});
          },
        },
      }),
    });

    const agentId = "00000000-0000-4000-8000-000000000003";

    const [extension] = await integrations.extensionsForAgent(
      store.createAgent(agent(agentId, [server.id]), agentId),
    );

    // SAFETY: MCP extensions expose their registered tool list.
    const tool = ((extension as any).tools as any[])[0];
    const started = performance.now();
    await expect(
      tool.execute(
        {},
        { taskId: "hung", conversationId: "conversation-a" },
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("MCP request timed out after 20ms");
    expect(performance.now() - started).toBeLessThan(500);
    await close();
    store.close();
  });

  test("does not invoke a client after caller cancellation", async () => {
    const dir = (await tempDir()).trim();
    const store = new Store(dir);

    const server = store.createMCPServer({
      name: "cancelled",
      url: "https://mcp.example.test",
      enabled: true,
    });

    let called = 0;

    const { integrations, close } = standaloneIntegrations(store.runtime, {
      requestTimeoutMs: 1_000,
      clientFactory: () => ({
        transport: unusedTransport,
        client: {
          async connect() {},
          async close() {},
          async listTools() {
            return [{ name: "send", inputSchema: { type: "object" } }];
          },
          async callTool() {
            called++;

            return { content: [{ type: "text", text: "sent" }] };
          },
        },
      }),
    });

    const agentId = "00000000-0000-4000-8000-000000000004";

    const [extension] = await integrations.extensionsForAgent(
      store.createAgent(agent(agentId, [server.id]), agentId),
    );

    // SAFETY: MCP extensions expose their registered tool list.
    const tool = ((extension as any).tools as any[])[0];
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    await expect(
      tool.execute(
        {},
        { taskId: "cancelled", conversationId: "conversation-a" },
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      ),
    ).rejects.toBe(reason);
    expect(called).toBe(0);
    await close();
    store.close();
  });

  test("propagates caller cancellation while a client is pending", async () => {
    const dir = (await tempDir()).trim();
    const store = new Store(dir);

    const server = store.createMCPServer({
      name: "cancelled-pending",
      url: "https://mcp.example.test",
      enabled: true,
    });

    let called = 0;

    const { integrations, close } = standaloneIntegrations(store.runtime, {
      requestTimeoutMs: 1_000,
      clientFactory: () => ({
        transport: unusedTransport,
        client: {
          async connect() {},
          async close() {},
          async listTools() {
            return [{ name: "send", inputSchema: { type: "object" } }];
          },
          async callTool(
            _name: string,
            _args: { [key: string]: string },
            options?: { signal?: AbortSignal },
          ) {
            called++;

            return await new Promise<never>((_, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(options.signal?.reason),
                { once: true },
              );
            });
          },
        },
      }),
    });

    const agentId = "00000000-0000-4000-8000-000000000005";

    const [extension] = await integrations.extensionsForAgent(
      store.createAgent(agent(agentId, [server.id]), agentId),
    );

    // SAFETY: MCP extensions expose their registered tool list.
    const tool = ((extension as any).tools as any[])[0];
    const controller = new AbortController();
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);

    const pending = tool.execute(
      {},
      { taskId: "cancelled-pending", conversationId: "conversation-a" },
      context,
    );

    for (let i = 0; i < 50 && called === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const reason = new Error("caller cancelled while pending");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(called).toBe(1);
    await close();
    store.close();
  });
});

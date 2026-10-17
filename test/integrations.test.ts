import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Agent, MCPServer } from "../src/domain";
import {
  ApprovalManager,
  MCPIntegrations,
  type MCPClient,
} from "../src/integrations";
import { Store } from "../src/store";

const agent = (id: string, mcpServers: string[]): Agent => ({
  id,
  name: "worker",
  avatar: "sparkles",
  description: "",
  instructions: "",
  provider: "openai",
  model: "test",
  enabled: true,
  folder: "Personal",
  tools: [],
  skills: [],
  mcpServers,
  delegates: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

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
        return {
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
              annotations: { readOnlyHint: true },
            },
          ],
        };
      },
      async callTool() {
        called++;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const integrations = new MCPIntegrations(store, {
      clientFactory: () => ({ client, transport: {} }),
    });
    const agentId = "00000000-0000-4000-8000-000000000001";
    const extensions = await integrations.extensionsForAgent(
      store.createAgent(agent(agentId, [server.id]), agentId),
    );
    expect(extensions).toHaveLength(1);
    const first = extensions[0];
    if (!first) throw new Error("missing extension");
    const tools = (first as any).tools as any[];
    expect(tools).toHaveLength(1);
    const tool: any = tools[0];
    if (!tool) throw new Error("missing tool");
    const result = await tool.execute(
      { text: "hi" },
      { taskId: "task-read", conversationId: "conversation-a" },
      BACKGROUND_CONTEXT,
    );
    expect((result.output as any)[0].text).toBe("ok");
    expect(called).toBe(1);
    await integrations.close();
    store.close();
  });

  test("persists a side-effect approval, waits, and resumes after decision", async () => {
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
        return { tools: [{ name: "send", inputSchema: { type: "object" } }] };
      },
      async callTool() {
        called++;
        return { content: [{ type: "text", text: "sent" }] };
      },
    };
    const integrations = new MCPIntegrations(store, {
      clientFactory: () => ({ client, transport: {} }),
    });
    const agentId = "00000000-0000-4000-8000-000000000002";
    const [extension] = await integrations.extensionsForAgent(
      store.createAgent(agent(agentId, [server.id]), agentId),
    );
    if (!extension) throw new Error("missing extension");
    const tools = (extension as any).tools as any[];
    const tool: any = tools[0];
    if (!tool) throw new Error("missing tool");
    const pending = tool.execute(
      { to: "user@example.test" },
      { taskId: "durable-task-1", conversationId: "conversation-a" },
      BACKGROUND_CONTEXT,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const approval = integrations.approvals.list(agentId)[0]!;
    expect(approval.status).toBe("pending");
    expect(called).toBe(0);
    const restarted = new ApprovalManager(store);
    expect(restarted.list(agentId)[0]!.status).toBe("pending");
    integrations.approvals.decide(approval.id, "approved");
    expect(((await pending).output as any)[0].text).toBe("sent");
    expect(called).toBe(1);
    expect(integrations.approvals.decide(approval.id, "denied")!.status).toBe(
      "approved",
    );
    await integrations.close();
    store.close();
  });
});

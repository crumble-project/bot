import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Agent } from "../shared/domain";
import { standaloneIntegrations } from "./integrations";
import { Store } from "../../test/support/store";

const agent = (id: string, mcpServers: string[]): Agent => ({
  id,
  name: "http-worker",
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

async function startMcp() {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let calls = 0;

  const makeServer = () => {
    const server = new McpServer({ name: "crumble-test", version: "1.0.0" });
    server.registerTool(
      "echo",
      {
        description: "Read-only echo",
        inputSchema: { text: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ text }) => ({
        content: [{ type: "text", text: `echo:${text}` }],
      }),
    );
    server.registerTool(
      "send",
      { description: "Side effect", inputSchema: { text: z.string() } },
      async ({ text }) => {
        calls++;

        return { content: [{ type: "text", text: `sent:${text}` }] };
      },
    );

    return server;
  };

  const http = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const sessionId = request.headers.get("mcp-session-id");
      let transport = sessionId ? sessions.get(sessionId) : undefined;

      if (!transport) {
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) sessions.delete(transport.sessionId);
        };

        await makeServer().connect(transport);
      }

      return transport.handleRequest(request);
    },
  });

  return {
    url: `http://127.0.0.1:${http.port}`,
    calls: () => calls,
    stop: async () => {
      await Promise.all([...sessions.values()].map((s) => s.close()));
      void http.stop();
    },
  };
}

describe("real Streamable HTTP MCP integration", () => {
  test("discovers and executes read-only and side-effect tools directly", async () => {
    const mcp = await startMcp();
    const dir = (await Bun.$`mktemp -d`.text()).trim();
    const store = new Store(dir);

    const server = store.createMCPServer({
      name: "local",
      url: mcp.url,
      enabled: true,
    });

    const id = "00000000-0000-4000-8000-000000000011";

    const { integrations, close } = standaloneIntegrations(store.runtime, {
      requestTimeoutMs: 3_000,
    });

    const [extension] = await integrations.extensionsForAgent(
      store.createAgent(agent(id, [server.id]), id),
    );

    if (!extension) throw new Error("missing extension");
    // SAFETY: MCP extensions expose their registered tool list.
    const tools = (extension as any).tools as any[];
    expect(tools).toHaveLength(2);
    const echo = tools.find((tool) => tool.name.endsWith("_echo"));
    const send = tools.find((tool) => tool.name.endsWith("_send"));

    const read = await echo.execute(
      { text: "hello" },
      { taskId: "http-read", conversationId: "c-http" },
      BACKGROUND_CONTEXT,
    );

    // SAFETY: The faux MCP tool returns a text output item.
    expect((read.output as any)[0].text).toBe("echo:hello");

    const sent = await send.execute(
      { text: "hello" },
      { taskId: "http-send", conversationId: "c-http" },
      BACKGROUND_CONTEXT,
    );

    // SAFETY: The faux MCP tool returns a text output item.
    expect((sent.output as any)[0].text).toBe("sent:hello");
    expect(mcp.calls()).toBe(1);
    await close();
    store.close();
    await mcp.stop();
  });

  test("revalidates a revoked server before a direct call", async () => {
    const mcp = await startMcp();
    const dir = (await Bun.$`mktemp -d`.text()).trim();
    const store = new Store(dir);

    const server = store.createMCPServer({
      name: "local",
      url: mcp.url,
      enabled: true,
    });

    const id = "00000000-0000-4000-8000-000000000012";

    const { integrations, close } = standaloneIntegrations(store.runtime, {
      requestTimeoutMs: 3_000,
    });

    const [extension] = await integrations.extensionsForAgent(
      store.createAgent(agent(id, [server.id]), id),
    );

    if (!extension) throw new Error("missing extension");

    // SAFETY: MCP extensions expose their registered tool list.
    const send = ((extension as any).tools as any[]).find((tool) =>
      tool.name.endsWith("_send"),
    );

    store.updateMCPServer(server.id, { enabled: false });

    const pending = send.execute(
      { text: "revoked" },
      { taskId: "http-revoked", conversationId: "c-revoke" },
      BACKGROUND_CONTEXT,
    );

    await expect(pending).rejects.toThrow("no longer enabled");
    expect(mcp.calls()).toBe(0);
    await close();
    store.close();
    await mcp.stop();
  });
});

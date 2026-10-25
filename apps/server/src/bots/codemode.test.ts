import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { AgentRuntime } from "./runtime";
import { CrumbleService } from "./service";
import { Store } from "../shared/store";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

test("code mode offers one tool whose scripts call the agent's other tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-codemode-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
  cleanups.push(() => sandbox.close());

  const echoed: string[] = [];

  const echo = defineTool({
    name: "echo",
    description: "Repeat the text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args: { text: string }) => {
      echoed.push(args.text);

      return { output: [{ type: "text" as const, text: `echo:${args.text}` }] };
    },
  });

  const offered: string[][] = [];
  let toolResult = "";
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses([
    (context) => {
      // Tools reach the model as declarations on the transcript's system messages.
      offered.push(
        context.messages.flatMap((message) =>
          message.role === "system"
            ? (message.toolsAdded ?? []).map((tool) => tool.name)
            : [],
        ),
      );

      return fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: 'const reply = await tools.echo({ text: "hi" });\ntext(reply);',
        }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      toolResult = JSON.stringify(context.messages.at(-1));

      return fauxAssistantMessage("The tool said hi.");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new Store(dir);

  const service = new CrumbleService(
    store,
    new AgentRuntime(dir, {
      models,
      extensions: () => [
        defineExtension({ name: "echo", tools: [echo] }),
        createCodemodeExtension({ sandbox }),
      ],
    }),
  );

  cleanups.push(() => service.close());

  const agent = store.createAgent({
    name: "Scripter",
    avatar: "bot",
    description: "",
    instructions: "Use code mode",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: ["codemode"],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  await service.sendChat(
    agent.id,
    "say hi through the tool",
    "00000000-0000-4000-8000-000000000001",
  );
  // The submission settles when the model answers; the tool call and the final reply follow it.
  let reply = "";

  for (let i = 0; i < 500 && !reply; i++) {
    const { messages } = await service.chatSnapshot(agent.id);
    reply =
      messages.findLast(
        (message) =>
          message.role === "assistant" &&
          !message.content.startsWith("Tool call"),
      )?.content ?? "";

    if (!reply) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  expect(reply).toBe("The tool said hi.");
  expect(offered[0]).toEqual(["codemode"]);
  expect(echoed).toEqual(["hi"]);
  expect(toolResult).toContain("echo:hi");
});

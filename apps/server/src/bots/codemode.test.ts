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
import {
  defineExtension,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { AgentRuntime } from "./runtime";
import { standaloneBots } from "./bots";
import { Store } from "../../test/support/store";
import {
  scheduleExtension,
  standaloneBotSchedules,
} from "../schedules/bot-schedules";
import { coordinationExtension } from "../bot-messaging/coordination";
import {
  credentialExtension,
  credentialsAccess,
} from "../credentials/credentials";
import { standaloneMessaging } from "../bot-messaging/bot-messaging";

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

  const service = standaloneBots(
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

test("code mode keeps request_credential a direct tool, so the chat can offer its form", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-codemode-credential-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
  cleanups.push(() => sandbox.close());
  const store = new Store(dir);
  const credentials = credentialsAccess(store.runtime);
  let offered: string[] = [];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses([
    (context) => {
      offered = context.messages.flatMap((message) =>
        message.role === "system"
          ? (message.toolsAdded ?? []).map((tool) => tool.name)
          : [],
      );

      return fauxAssistantMessage("Done.");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);

  const service = standaloneBots(
    store,
    new AgentRuntime(dir, {
      models,
      extensions: (agent): Extension[] => [
        credentialExtension(agent.id, credentials),
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
    tools: ["codemode", "coding"],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  await service.sendChat(
    agent.id,
    "Ask me for a token",
    "00000000-0000-4000-8000-000000000003",
  );

  for (let i = 0; i < 500 && !offered.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(offered).toContain("codemode");
  expect(offered).toContain("request_credential");
});

test("code mode receives structured schedule and coordination results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-codemode-results-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
  cleanups.push(() => sandbox.close());
  const store = new Store(dir);

  const schedules = standaloneBotSchedules(store.runtime, async () => ({
    id: "exec-1",
  }));

  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  let toolResult = "";
  let finished = false;
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: `const results = await Promise.allSettled([
          tools.schedule({ action: "create", name: "Reminder", prompt: "Send the note", runAt: "2099-01-01T12:00:00Z" }),
          tools.schedule({ action: "list" }),
          tools.list_bots({}),
        ]);
        text(results.map(result => result.status).join("|"));
        const created = results[0];
        const listed = results[1];
        const bots = results[2];
        text({
          created: created.status === "fulfilled" && created.value.name === "Reminder" && created.value.command === null,
          listed: listed.status === "fulfilled" && Array.isArray(listed.value),
          bots: bots.status === "fulfilled" && bots.value[0].name === "Target",
          errors: results.filter(result => result.status === "rejected").map(result => result.reason.message),
        });`,
      }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      toolResult = JSON.stringify(context.messages.at(-1));
      finished = true;

      return fauxAssistantMessage("Done.");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);

  const service = standaloneBots(
    store,
    new AgentRuntime(dir, {
      models,
      extensions: (agent): Extension[] => [
        scheduleExtension(agent, schedules.service),
        coordinationExtension(agent, standaloneMessaging(service)),
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
    tools: ["schedule", "delegate", "codemode"],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  store.createAgent({
    name: "Target",
    avatar: "bot",
    description: "A recipient",
    instructions: "",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });
  await service.sendChat(
    agent.id,
    "Schedule a reminder and list bots",
    "00000000-0000-4000-8000-000000000002",
  );

  for (let i = 0; i < 500 && !finished; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(finished).toBe(true);
  expect(toolResult).toContain("fulfilled|fulfilled|fulfilled");
  expect(toolResult).toContain('\\"created\\":true');
  expect(toolResult).toContain('\\"listed\\":true');
  expect(toolResult).toContain('\\"bots\\":true');
});

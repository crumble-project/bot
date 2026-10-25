import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type, createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Agent } from "../src/domain";
import { reactionExtension } from "../src/reaction";
import { AgentRuntime } from "../src/runtime";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const agent: Agent = {
  id: "00000000-0000-4000-8000-000000000501",
  name: "Ada",
  avatar: "bot",
  description: "",
  instructions: "",
  provider: "faux",
  model: "chat",
  enabled: true,
  tools: ["memory"],
  skills: [],
  mcpServers: [],
  delegates: [],
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

const textOf = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

/** Answers by the last input's text, and records the tools each request offered. */
function script(offered: string[][]): FauxResponseFactory {
  return async (context) => {
    offered.push(
      context.messages.flatMap((message) =>
        message.role === "system"
          ? (message.toolsAdded ?? []).map((tool) => tool.name)
          : [],
      ),
    );

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    const call = (name: string, args: Record<string, string>) =>
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

    if (last.role === "toolResult")
      return fauxAssistantMessage([fauxText("unexpected")]);
    const text = textOf(last);

    if (text === "react") return call("react", { emoji: "👍" });

    if (text === "pass") return call("pass", {});

    if (text === "empty") return fauxAssistantMessage([fauxText("")]);

    return fauxAssistantMessage([fauxText(`Answer to ${text}`)]);
  };
}

// Stands in for bot messaging: a group turn must not be offered it.
const coordination = defineExtension({
  name: "coordination",
  tools: [
    defineTool({
      name: "delegate",
      description: "Message another bot.",
      parameters: Type.Object({}),
      callers: ["model"],
      execute: async () => ({ output: [{ type: "text", text: "Sent." }] }),
    }),
  ],
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-turns-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const offered: string[][] = [];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(Array.from({ length: 20 }, () => script(offered)));
  const models = createModels();
  models.setProvider(faux.provider);

  const runtime = new AgentRuntime(dir, {
    models,
    extensions: () => [coordination, reactionExtension()],
  });

  cleanups.push(() => runtime.close());

  return { runtime, offered };
}

async function turn(runtime: AgentRuntime, conversation: string, text: string) {
  const submission = await runtime.submit(agent, conversation, text, text);
  await runtime.wait(submission, agent);

  return runtime.turnOutcome(agent, conversation, submission);
}

test("a group conversation offers pass and react but no delegation", async () => {
  const { runtime, offered } = open();
  const chat = await runtime.openChat(agent);
  const group = await runtime.openGroupConversation(agent, "group-1");

  await turn(runtime, group, "hello");
  expect(offered.at(-1)).toEqual(
    expect.arrayContaining(["memory", "react", "pass"]),
  );
  expect(offered.at(-1)).not.toContain("delegate");

  await turn(runtime, chat, "hi");
  expect(offered.at(-1)).toContain("delegate");
  expect(offered.at(-1)).not.toContain("pass");
});

test("a group conversation stays out of the bot chat", async () => {
  const { runtime } = open();
  const chat = await runtime.openChat(agent);
  const group = await runtime.openGroupConversation(agent, "group-1");

  await turn(runtime, group, "secret plan");

  const contents = [
    ...(await runtime.history(agent)).messages,
    ...(await runtime.snapshot(agent, chat)).messages,
  ].map((message) => message.content);

  expect(contents.join("\n")).not.toContain("secret plan");
});

test("a turn's outcome is its answer, a reaction, or a pass", async () => {
  const { runtime } = open();
  const group = await runtime.openGroupConversation(agent, "group-1");

  expect(await turn(runtime, group, "plans")).toEqual({
    kind: "message",
    text: "Answer to plans",
  });
  expect(await turn(runtime, group, "react")).toEqual({
    kind: "reaction",
    emoji: "👍",
  });
  expect(await turn(runtime, group, "pass")).toEqual({ kind: "pass" });
  expect(await turn(runtime, group, "empty")).toEqual({ kind: "pass" });
});

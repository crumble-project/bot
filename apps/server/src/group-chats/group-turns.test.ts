import { afterEach, expect, test } from "bun:test";
import { openGroupConversation } from "./group-turns";
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
import { Effect, Layer } from "effect";
import { Plugins } from "../plugins/plugins";
import { BotExtensions } from "../bot-ports/bot-extensions";
import { chatOnly } from "../shared/chat-only";
import { configuredWebSearchTools } from "../web-search/web-search-tools";
import { AgentRepository } from "../bot-store/agent-repository";
import { SettingsRepository } from "../shared/settings-repository";
import type { Agent } from "../contract/agents";
import { defaultAvatarDefinition } from "../contract/avatar";
import { reactionExtension } from "../bots/reaction";
import { AgentRuntime } from "../bots/runtime";
import { turnOutcome } from "./group-turn-outcome";
import { turnReport } from "../learning/turn-report";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const agent: Agent = {
  id: "00000000-0000-4000-8000-000000000501",
  name: "Ada",
  avatar: defaultAvatarDefinition("ada"),
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

const coordination = chatOnly(
  defineExtension({
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
  }),
);

function open(
  extensions?: (agent: Agent) => Promise<ReturnType<typeof defineExtension>[]>,
) {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-turns-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const offered: string[][] = [];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(Array.from({ length: 20 }, () => script(offered)));
  const models = createModels();
  models.setProvider(faux.provider);

  const runtime = new AgentRuntime(
    dir,
    runtimeCallbacks({
      models,
      extensions: extensions ?? (() => [coordination, reactionExtension()]),
    }),
  );

  cleanups.push(() => runtime.close());

  return { runtime, offered };
}

async function turn(runtime: AgentRuntime, conversation: string, text: string) {
  const submission = await runtime.submit(agent, conversation, text, text);
  await runtime.wait(submission, agent);

  return turnOutcome(runtime, agent, conversation, submission);
}

test("a group conversation offers pass and react but no delegation", async () => {
  const { runtime, offered } = open();
  const chat = await runtime.openChat(agent);
  const group = await openGroupConversation(runtime, agent, "group-1");

  await turn(runtime, group, "hello");
  expect(offered.at(-1)).toEqual([
    "memory",
    "skill_manage",
    "library",
    "react",
    "pass",
  ]);

  await turn(runtime, chat, "hi");
  expect(offered.at(-1)).toEqual([
    "memory",
    "skill_manage",
    "library",
    "delegate",
    "react",
  ]);
});

test("a turn longer than one entry page is read to its end", async () => {
  const rounds = 110;
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });

  faux.setResponses([
    ...Array.from({ length: rounds }, () =>
      fauxAssistantMessage(fauxToolCall("ping", {}), { stopReason: "toolUse" }),
    ),
    fauxAssistantMessage([fauxText("The final answer")]),
    fauxAssistantMessage([fauxText("The next turn")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const dir = mkdtempSync(join(tmpdir(), "bot-long-turn-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const ping = defineExtension({
    name: "ping",
    tools: [
      defineTool({
        name: "ping",
        description: "Ping.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({ output: [{ type: "text", text: "pong" }] }),
      }),
    ],
  });

  const runtime = new AgentRuntime(
    dir,
    runtimeCallbacks({ models, extensions: () => [ping] }),
  );

  cleanups.push(() => runtime.close());
  await runtime.openChat(agent);
  const group = await openGroupConversation(runtime, agent, "group-1");
  const long = await runtime.submit(agent, group, "work", "long");
  await runtime.wait(long, agent);
  const next = await runtime.submit(agent, group, "again", "next");
  await runtime.wait(next, agent);

  expect(await turnOutcome(runtime, agent, group, long)).toEqual({
    kind: "message",
    text: "The final answer",
    sources: [],
  });
  expect(await runtime.response(agent, group, long)).toEqual([
    "The final answer",
  ]);

  const report = await turnReport(runtime, agent, group, long, 100_000);

  expect(report.rounds).toBe(rounds);
  expect(report.digest).toContain("The final answer");
  expect(report.digest).not.toContain("The next turn");
});

test("web tools are offered in bot chat and group turns", async () => {
  const layers = configuredWebSearchTools.pipe(
    Layer.provideMerge(BotExtensions.layer),
    Layer.provide(Layer.mock(AgentRepository)({})),
    Layer.provide(Layer.mock(SettingsRepository)({})),
    Layer.provide(
      Layer.succeed(Plugins, [
        {
          id: "offline",
          webSearchProviders: [
            {
              id: "offline",
              search: () => Effect.succeed([]),
              extract: (url) => Effect.succeed({ url, title: "", text: "" }),
            },
          ],
        },
      ]),
    ),
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* BotExtensions;
        const enabled = { ...agent, tools: [...agent.tools, "web"] };
        const { runtime, offered } = open((bot) => registry.forAgent(bot));
        const chat = yield* Effect.promise(() => runtime.openChat(enabled));

        const group = yield* Effect.promise(() =>
          openGroupConversation(runtime, enabled, "group-1"),
        );

        yield* Effect.promise(async () => {
          const submission = await runtime.submit(enabled, chat, "hi", "hi");

          await runtime.wait(submission, enabled);
        });
        expect(offered.at(-1)).toEqual([
          "memory",
          "skill_manage",
          "library",
          "web_search",
          "web_extract",
        ]);

        yield* Effect.promise(async () => {
          const submission = await runtime.submit(
            enabled,
            group,
            "hello",
            "hello",
          );

          await runtime.wait(submission, enabled);
        });
        expect(offered.at(-1)).toEqual([
          "memory",
          "skill_manage",
          "library",
          "web_search",
          "web_extract",
          "pass",
        ]);
      }).pipe(Effect.provide(layers)),
    ),
  );
});

test("a group conversation stays out of the bot chat", async () => {
  const { runtime } = open();
  const chat = await runtime.openChat(agent);
  const group = await openGroupConversation(runtime, agent, "group-1");

  expect(await turn(runtime, group, "secret plan")).toEqual({
    kind: "message",
    text: "Answer to secret plan",
    sources: [],
  });
  expect((await runtime.history(agent)).messages).toEqual([]);
  expect((await runtime.snapshot(agent, chat)).messages).toEqual([]);
});

test("a turn's outcome is its answer, a reaction, or a pass", async () => {
  const { runtime } = open();
  const group = await openGroupConversation(runtime, agent, "group-1");

  expect(await turn(runtime, group, "plans")).toEqual({
    kind: "message",
    text: "Answer to plans",
    sources: [],
  });
  expect(await turn(runtime, group, "react")).toEqual({
    kind: "reaction",
    emoji: "👍",
  });
  expect(await turn(runtime, group, "pass")).toEqual({ kind: "pass" });
  expect(await turn(runtime, group, "empty")).toEqual({ kind: "pass" });
});

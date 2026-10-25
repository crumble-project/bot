import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { z } from "zod";
import { standaloneGroupChats } from "./group-chats";
import { groupLookupExtension } from "./group-lookup";
import { GroupTranscripts } from "./group-transcripts";
import { AgentRuntime } from "../bots/runtime";
import { standaloneBots } from "../bots/bots";
import { Store } from "../../test/support/store";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const textOf = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

/** The owner's message is the tool call's arguments as JSON; a tool result ends the turn. */
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

    if (last.role === "toolResult")
      return fauxAssistantMessage([fauxText("Looked it up.")]);

    return fauxAssistantMessage(
      fauxToolCall("group_chats", JSON.parse(textOf(last))),
      { stopReason: "toolUse" },
    );
  };
}

const bot = (name: string) => ({
  name,
  avatar: "bot",
  description: "",
  instructions: "",
  provider: "faux",
  model: "chat",
  // Disabled, so posting starts no group turns; the runtime is driven directly.
  enabled: false,
  tools: [],
  skills: [],
  mcpServers: [],
  delegates: [],
});

const lookup = z.object({
  groups: z
    .array(z.object({ name: z.string(), members: z.array(z.string()) }))
    .optional(),
  messages: z
    .array(z.object({ sender: z.string(), text: z.string() }))
    .optional(),
  before: z.string().nullable().optional(),
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-lookup-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const offered: string[][] = [];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(Array.from({ length: 20 }, () => script(offered)));
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new Store(dir);
  let groups!: ReturnType<typeof standaloneGroupChats>;

  const runtime = new AgentRuntime(join(dir, "agents"), {
    models,
    extensions: (agent) => [groupLookupExtension(agent, groups.service)],
  });

  const service = standaloneBots(store, runtime);
  groups = standaloneGroupChats(
    service,
    new GroupTranscripts(join(dir, "groups")),
  );

  cleanups.push(async () => {
    await groups.close();
    await service.close();
  });

  const [ada, grace, hopper] = ["Ada", "Grace", "Hopper"].map((name) =>
    store.createAgent(bot(name)),
  );

  const trip = groups.create({ name: "Trip", memberIds: [ada!.id, grace!.id] });
  groups.create({ name: "Other", memberIds: [grace!.id, hopper!.id] });

  for (let i = 1; i <= 35; i++)
    await groups.post(trip.id, `Message ${i}`, crypto.randomUUID());

  const agent = { ...ada!, enabled: true };
  const chat = await runtime.openChat(agent);

  /** Runs one bot chat turn that calls the tool and returns its parsed result. */
  const call = async (args: Record<string, string>) => {
    const submission = await runtime.submit(agent, chat, JSON.stringify(args));
    await runtime.wait(submission, agent);

    const result = (await runtime.history(agent)).messages.findLast(
      (message) => message.role === "toolResult",
    );

    return lookup.parse(JSON.parse(result!.content));
  };

  return { runtime, agent, trip, offered, call };
}

test("lists only the bot's groups", async () => {
  const { call } = await setup();

  expect((await call({ action: "list" })).groups).toEqual([
    expect.objectContaining({ name: "Trip", members: ["Ada", "Grace"] }),
  ]);
});

test("reads the newest messages and pages back", async () => {
  const { call, trip } = await setup();
  const first = await call({ action: "read", groupId: trip.id });

  expect(first.messages).toHaveLength(30);
  expect(first.messages![0]).toEqual({ sender: "Owner", text: "Message 6" });
  expect(first.messages!.at(-1)?.text).toBe("Message 35");

  const older = await call({
    action: "read",
    groupId: trip.id,
    before: first.before!,
  });

  expect(older.messages!.map((message) => message.text)).toEqual(
    [1, 2, 3, 4, 5].map((n) => `Message ${n}`),
  );
  expect(older.before).toBeNull();
});

test("a group the bot is not in reads as not found", async () => {
  const { runtime, agent, call } = await setup();
  const other = crypto.randomUUID();

  await expect(call({ action: "read", groupId: other })).rejects.toThrow();

  const result = (await runtime.history(agent)).messages.findLast(
    (message) => message.role === "toolResult",
  );

  expect(result?.isError).toBe(true);
  expect(result?.content).toContain("Group chat not found");
});

test("is offered in the bot chat but not in a group turn", async () => {
  const { runtime, agent, offered, call } = await setup();

  await call({ action: "list" });
  expect(offered.at(-1)).toContain("group_chats");

  const group = await runtime.openGroupConversation(agent, "group-1");

  const submission = await runtime.submit(
    agent,
    group,
    JSON.stringify({ action: "list" }),
  );

  await runtime.wait(submission, agent);
  expect(offered.at(-1)).not.toContain("group_chats");
});

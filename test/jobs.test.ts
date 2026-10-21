import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@earendil-works/chord";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defineJobKind, type JobKindOptions } from "../src/jobs";
import { AgentRuntime } from "../src/runtime";
import { Store } from "../src/store";
import type { Workspaces } from "../src/workspace";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

class DirectoryWorkspaces implements Workspaces {
  readonly desktop = false;

  constructor(readonly dir: string) {}

  env(_agentId: string) {
    return new NodeExecutionEnv({ cwd: this.dir });
  }

  async sync(_agentId: string, _context: Context) {}

  async restart(_agentId: string, _context: Context) {}

  async close(_context: Context) {}
}

const kindOptions = (exclusive: boolean): JobKindOptions => ({
  kind: exclusive ? "test-exclusive" : "test-parallel",
  toolName: "errand",
  label: "errand",
  description: "Run errands.",
  instructions: "You run one errand.",
  exclusive,
});

const exclusiveKind = defineJobKind(kindOptions(true));
const parallelKind = defineJobKind(kindOptions(false));

const textOf = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

/** The bot starts the errand its message names; a job records that its model was asked, and waits for release. */
function script(
  started: string[],
  release: Promise<void>,
): FauxResponseFactory {
  return async (context) => {
    const tools = context.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    const text = textOf(last);

    if (!tools.includes("errand")) {
      started.push(text);
      await release;

      return fauxAssistantMessage([fauxText(`${text} done`)]);
    }

    if (text.startsWith("[errand"))
      return fauxAssistantMessage([fauxText("Noted.")]);

    const name = text.replace("start ", "");

    return fauxAssistantMessage(
      fauxToolCall("errand", {
        action: "start",
        name,
        message: `errand ${name}`,
      }),
      { stopReason: "toolUse" },
    );
  };
}

async function run(kind: typeof exclusiveKind) {
  const dir = mkdtempSync(join(tmpdir(), "bot-jobs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const agent = store.createAgent({
    name: "Runner",
    avatar: "bot",
    description: "",
    instructions: "",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: ["errand"],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  const started: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));

  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(
    Array.from({ length: 40 }, () => script(started, released)),
  );
  const models = createModels();
  models.setProvider(faux.provider);

  const workspaces = new DirectoryWorkspaces(dir);
  const job = defineExtension({ name: "errand-job" });
  const extensions = kind.extensions({ agentId: agent.id, job });

  const runtime = new AgentRuntime(dir, {
    models,
    extensions: () => extensions.chat,
    taskExtensions: () => extensions.job,
    env: (agentId, target, context) =>
      kind.env(workspaces, agentId, target, context),
  });

  cleanups.push(() => runtime.close());

  const chat = await runtime.openChat(agent);
  await runtime.submit(agent, chat, "start a", "req-a");
  await until(() => started.includes("errand a"));
  await runtime.submit(agent, chat, "start b", "req-b");

  return { started, release };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));

  expect(check()).toBe(true);
}

test("an exclusive job waits while another job of its kind works", async () => {
  const { started, release } = await run(exclusiveKind);

  // Long enough for errand b to reach its model if it did not wait.
  await Bun.sleep(1500);
  expect(started).toEqual(["errand a"]);

  release();
  await until(() => started.includes("errand b"));
  expect(started).toEqual(["errand a", "errand b"]);
});

test("jobs of other kinds run side by side", async () => {
  const { started, release } = await run(parallelKind);

  await until(() => started.includes("errand b"));
  release();
});

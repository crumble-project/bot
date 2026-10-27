import { afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
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
import { defineJobKind, type JobKindOptions } from "./jobs";
import { AgentRuntime } from "../bots/runtime";
import { Store } from "../../test/support/store";
import type { Workspaces } from "../workspaces/workspace";
import { DesktopNotConfigured } from "../workspaces/workspace-errors";

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

  sync(_agentId: string) {
    return Effect.void;
  }

  restart(_agentId: string) {
    return Effect.void;
  }

  openDesktop(_agentId: string) {
    return Effect.fail(
      new DesktopNotConfigured({ message: "No bot desktop in this test" }),
    );
  }

  startDesktop(_agentId: string) {
    return Effect.void;
  }

  keepAwake(_agentId: string) {
    return () => {};
  }
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

/** Each job's model call waits until the test releases that job. */
class Gates {
  readonly started: string[] = [];
  private readonly gates = new Map<string, () => void>();
  private readonly waits = new Map<string, Promise<void>>();

  wait(name: string) {
    this.started.push(name);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    this.gates.set(name, open);
    this.waits.set(name, gate);

    return gate;
  }

  release(name: string) {
    this.gates.get(name)?.();
  }
}

/** The bot starts or stops the errand its message names; a job's model waits at its gate. */
function script(gates: Gates): FauxResponseFactory {
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
      const name = text.replace("errand ", "");
      await gates.wait(name);

      return fauxAssistantMessage([fauxText(`${name} done`)]);
    }

    if (text.startsWith("[errand") || last.role === "toolResult")
      return fauxAssistantMessage([fauxText("Noted.")]);

    const [action, name] = text.split(" ");

    return fauxAssistantMessage(
      fauxToolCall("errand", {
        action: action!,
        name: name!,
        ...(action === "start" && { message: `errand ${name}` }),
      }),
      { stopReason: "toolUse" },
    );
  };
}

async function open(kind: typeof exclusiveKind) {
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

  const gates = new Gates();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(Array.from({ length: 60 }, () => script(gates)));
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
  let requests = 0;

  // Each bot message runs one turn; the next waits until the chat is idle again.
  const say = async (text: string) => {
    const submission = await runtime.submit(
      agent,
      chat,
      text,
      `req-${++requests}`,
    );

    await runtime.wait(submission, agent);
  };

  // The bot's latest job tool result, such as a status listing.
  const lastToolResult = async () =>
    (await runtime.snapshot(agent, chat)).messages.findLast(
      (message) => message.toolName === "errand",
    )?.content;

  return { gates, say, lastToolResult };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));

  expect(check()).toBe(true);
}

// Long enough for a job that did not wait to reach its model.
const SETTLE_MS = 1500;

// Tests that settle spend seconds in fixed sleeps; bun's 5 s default fails on slow CI runners.
const SETTLING_TEST_MS = 15_000;

export {
  exclusiveKind,
  parallelKind,
  open,
  until,
  SETTLE_MS,
  SETTLING_TEST_MS,
};

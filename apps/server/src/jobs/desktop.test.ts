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
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { desktopAnswers, desktopEnv, desktopExtensions } from "./desktop";
import type { JobAnswer } from "./jobs";
import type { Agent } from "../shared/domain";
import { AgentRuntime } from "../bots/runtime";
import { Store } from "../../test/support/store";
import { latestMessagePreview } from "../bots/transcript";
import { Effect } from "effect";
import type { DesktopStream, WorkspaceService } from "../workspaces/workspace";
import {
  scriptedGuest,
  type GuestCall,
} from "../../test/fixtures/scripted-guest";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The workspace is a scripted bot desktop: cua-driver answers from replies, nothing runs. */
class GuestWorkspaces implements WorkspaceService {
  readonly desktop = true;
  readonly calls: GuestCall[];
  private readonly guest: ReturnType<typeof scriptedGuest>;

  constructor(readonly dir: string) {
    this.guest = scriptedGuest({
      list_windows: [
        {
          windows: [
            {
              pid: 7,
              window_id: 101,
              app_name: "Chromium",
              title: "Form - Chromium",
            },
          ],
        },
      ],
      get_window_state: [
        { snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' },
      ],
      set_value: [{ effect: "confirmed", summary: "Set value of [2]" }],
    });
    this.calls = this.guest.calls;
  }

  env(_agentId: string) {
    return Object.assign(new NodeExecutionEnv({ cwd: this.dir }), {
      exec: this.guest.shell.exec,
      writeFile: this.guest.shell.writeFile,
      readBinaryFile: this.guest.shell.readBinaryFile,
    });
  }

  sync() {
    return Effect.void;
  }

  restart() {
    return Effect.void;
  }

  openDesktop(): Effect.Effect<DesktopStream> {
    return Effect.die("No bot desktop in this test");
  }

  startDesktop() {
    return Effect.void;
  }

  keepAwake(_agentId: string) {
    return () => {};
  }

  get close() {
    return Effect.void;
  }
}

const textOf = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

type Role = "bot" | "job";

/** One scripted model plays the bot and its desktop job; the tools it was offered tell them apart. */
function script(
  offered: Map<Role, string[]>,
  models: Map<Role, string>,
): FauxResponseFactory {
  return async (context, _options, _state, model) => {
    const tools = context.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );

    const role: Role = tools.includes("computer_use") ? "job" : "bot";

    offered.set(role, tools);
    models.set(role, model.id);

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    const call = (name: string, args: Record<string, string | number>) =>
      fauxAssistantMessage(fauxToolCall(name, args), {
        stopReason: "toolUse",
      });

    if (role === "job") {
      if (last.role === "user")
        return call("computer_use", { action: "capture" });

      if (last.role === "toolResult" && textOf(last).includes("window 101"))
        return call("computer_use", {
          action: "set_value",
          element: 2,
          value: "Ada",
        });

      return fauxAssistantMessage([fauxText("Filled in Ada.")]);
    }

    if (textOf(last).startsWith("[desktop job"))
      return fauxAssistantMessage([fauxText("The form is filled.")]);

    return call("desktop", {
      action: "start",
      name: "form",
      message: "Fill the form with Ada.",
    });
  };
}

async function open(desktopModel?: Agent["desktopModel"]) {
  const dir = mkdtempSync(join(tmpdir(), "bot-desktop-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const agent = store.createAgent({
    name: "Desk",
    avatar: "bot",
    description: "",
    instructions: "",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: ["desktop"],
    skills: [],
    mcpServers: [],
    delegates: [],
    ...(desktopModel && { desktopModel }),
  });

  const offered = new Map<Role, string[]>();
  const used = new Map<Role, string>();

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "chat" }, { id: "desk" }],
  });

  faux.setResponses(Array.from({ length: 40 }, () => script(offered, used)));
  const models = createModels();
  models.setProvider(faux.provider);

  const workspaces = new GuestWorkspaces(dir);
  const extensions = desktopExtensions(agent);

  const runtime = new AgentRuntime(dir, {
    models,
    extensions: () => extensions.chat,
    taskExtensions: () => extensions.job,
    env: (agentId, target, context) =>
      desktopEnv(workspaces, agentId, target, context),
  });

  cleanups.push(() => runtime.close());

  const chat = await runtime.openChat(agent);

  await runtime.submit(agent, chat, "Fill in the form", "req-1");

  await until(async () =>
    (await runtime.snapshot(agent, chat)).messages.some(
      (message) => message.content === "The form is filled.",
    ),
  );

  return { runtime, agent, chat, offered, used, calls: workspaces.calls };
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 500 && !(await check()); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));

  expect(await check()).toBe(true);
}

test("a desktop job operates the bot desktop and reports to the bot's chat", async () => {
  const { runtime, agent, chat, offered, calls } = await open();
  const messages = (await runtime.snapshot(agent, chat)).messages;

  // The job has exactly computer_use: no shell, memory, delegation, or jobs. The chat never gets computer_use.
  expect(offered.get("job")).toEqual(["computer_use"]);
  expect(offered.get("bot")).toEqual(["desktop"]);

  const report = messages.find((message) => message.origin?.kind === "desktop");

  expect(report?.content).toBe("Filled in Ada.");
  expect(report?.origin?.name).toBe("form");

  const card = messages.find((message) => message.toolName === "desktop")!;

  expect(latestMessagePreview([card])).toBe("Desktop job form");

  // The job's set_value went to the element of the snapshot it captured.
  expect(calls.find((each) => each.tool === "set_value")?.args).toMatchObject({
    element_token: "s1:2",
    value: "Ada",
  });
});

test("desktop jobs run on the bot's desktop model", async () => {
  const { used } = await open({ provider: "faux", model: "desk" });

  expect(used.get("bot")).toBe("chat");
  expect(used.get("job")).toBe("desk");
});

test("without a desktop model, desktop jobs use the bot's model", async () => {
  const { used } = await open();

  expect(used.get("job")).toBe("chat");
});

test("the desktop job list reports each job's token usage", async () => {
  const { runtime, agent } = await open({ provider: "faux", model: "desk" });
  const [job] = await runtime.desktopJobs(agent);

  expect(job?.usage?.models["faux/desk"]?.totalTokens).toBeGreaterThan(0);
  // Only the job's own requests: the bot's model does not appear.
  expect(job?.usage?.models["faux/chat"]).toBeUndefined();
});

test("rebuilding a bot's extensions keeps the same computer_use tool", () => {
  const agent = { id: "00000000-0000-4000-8000-000000000501" };
  const toolOf = () => desktopExtensions(agent).job[0]?.tools?.[0];

  // A running job's snapshots and the lease count it last saw live in that tool.
  expect(toolOf()).toBe(toolOf());
});

test("the bot's answer to a desktop job's report is announced once, for notifications", async () => {
  const heard: JobAnswer[] = [];
  const stop = desktopAnswers((answer) => heard.push(answer));

  try {
    const { agent } = await open();

    await until(async () => heard.length > 0);
    await Bun.sleep(200);

    expect(heard).toEqual([
      {
        agentId: agent.id,
        kind: "desktop",
        name: "form",
        entryId: expect.any(String),
        preview: "The form is filled.",
        eventId: expect.stringMatching(/^desktop-report:/),
      },
    ]);
  } finally {
    stop();
  }
});

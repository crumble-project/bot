import { afterEach, expect, test } from "bun:test";
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
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  desktopAnswers,
  desktopEnv,
  desktopExtensions,
  type DesktopLogins,
} from "./desktop";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { JobAnswer } from "./jobs";
import type { DesktopIntent } from "./desktop-intent";
import type { IntentRequest } from "../bot-desktop/intent-check";
import type { MessageOrigin } from "../bots/transcript";
import type { Agent, Login } from "../shared/domain";
import type { LoginsAccess } from "../logins/logins";
import { AgentRuntime } from "../bots/runtime";
import { Store } from "../../test/support/store";
import { latestMessagePreview } from "../bots/transcript";
import type { Workspaces } from "../workspaces/workspace";
import { DesktopNotConfigured } from "../workspaces/workspace-errors";
import {
  scriptedGuest,
  type GuestCall,
} from "../../test/fixtures/scripted-guest";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The workspace is a scripted bot desktop: cua-driver answers from replies, nothing runs. */
class GuestWorkspaces implements Workspaces {
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

  desktopRunning(_agentId: string) {
    return false;
  }

  keepAwake(_agentId: string) {
    return () => {};
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
  sections: Map<Role, Record<string, string | null>>,
  start: JsonObject,
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
    sections.set(
      role,
      Object.assign(
        {},
        ...context.messages.flatMap((message) =>
          message.role === "system" ? [message.sections ?? {}] : [],
        ),
      ),
    );

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    const call = (name: string, args: JsonObject) =>
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

    // A start that succeeds ends the bot's turn, so only a failed one is answered.
    if (last.role === "toolResult")
      return fauxAssistantMessage([fauxText("The job did not start.")]);

    return call("desktop", {
      action: "start",
      name: "form",
      message: "Fill the form with Ada.",
      ...start,
    });
  };
}

type OpenOptions = {
  intent?: DesktopIntent;
  /** Arguments the bot adds to its start call. */
  start?: JsonObject;
  /** The opening message's origin; unset, it has none. */
  origin?: MessageOrigin;
  /** The bot's answer that ends the test's wait. */
  done?: string;
};

async function open(
  desktopModel?: Agent["desktopModel"],
  logins?: DesktopLogins,
  options: OpenOptions = {},
) {
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
  const sections = new Map<Role, Record<string, string | null>>();

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "chat" }, { id: "desk" }],
  });

  faux.setResponses(
    Array.from({ length: 40 }, () =>
      script(offered, used, sections, options.start ?? {}),
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);

  const workspaces = new GuestWorkspaces(dir);

  const extensions = desktopExtensions(
    agent,
    undefined,
    logins,
    options.intent,
  );

  const runtime = new AgentRuntime(dir, {
    models,
    extensions: () => extensions.chat,
    taskExtensions: () => extensions.job,
    env: (agentId, target, context) =>
      desktopEnv(workspaces, agentId, target, context),
  });

  cleanups.push(() => runtime.close());

  const chat = await runtime.openChat(agent);

  await runtime.submit(
    agent,
    chat,
    "Fill in the form",
    "req-1",
    options.origin && { origin: options.origin },
  );

  await until(async () =>
    (await runtime.snapshot(agent, chat)).messages.some(
      (message) => message.content === (options.done ?? "The form is filled."),
    ),
  );

  return {
    runtime,
    agent,
    chat,
    offered,
    used,
    sections,
    calls: workspaces.calls,
  };
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

test("a desktop job's prompt lists the bot's logins; the bot's chat gets request_login and its own list", async () => {
  const login: Login = {
    name: "github",
    hosts: ["github.com", "*.github.com"],
    fields: {
      username: { passwordManager: null, reference: null },
      password: { passwordManager: null, reference: null },
    },
    createdAt: "t",
    updatedAt: "t",
    lastUsedAt: null,
    lastError: null,
  };

  const logins: LoginsAccess = {
    list: () => [login],
    requests: () => [
      {
        name: "linear",
        hosts: ["linear.app"],
        reason: "Triage",
        oneTimeCode: false,
        requestedAt: "t",
      },
    ],
    request: () => {
      throw new Error("unused");
    },
    decline: async () => undefined,
    get: () => login,
    save: async () => login,
    delete: async () => undefined,
    uses: () => [],
    read: async () => ({ missing: "unused" }),
    recordUse: () => undefined,
  };

  const { sections, offered } = await open(undefined, {
    access: logins,
    fills: () => ({ list: async () => [], add: async () => undefined }),
  });

  expect(sections.get("job")?.["desktop_logins"]).toContain(
    "- github: github.com, *.github.com",
  );
  expect(sections.get("bot")?.["desktop_logins"] ?? null).toBeNull();
  expect(offered.get("bot")).toContain("request_login");
  expect(offered.get("job")).not.toContain("request_login");
  expect(sections.get("bot")?.["logins"]).toContain(
    [
      "Logins your desktop jobs have:",
      "- github: github.com, *.github.com",
      "Logins you asked for that the owner has not answered:",
      "- linear: linear.app",
    ].join("\n"),
  );
});

test("without logins, a desktop job's prompt has no logins section", async () => {
  const { sections } = await open();

  expect(sections.get("job")?.["desktop_logins"]).toBeUndefined();
});

/** A judge that answers every check as asked for, recording what it read; nothing is ever held. */
function recordingIntent(seen: IntentRequest[]): DesktopIntent {
  return {
    judgeFor: async () => ({
      name: "Recording judge",
      judge: async (request) => {
        seen.push(request);

        return { irreversible: 0, inIntent: 1, inIntentBar: 0.9 };
      },
    }),
    held: {
      list: () => [],
      decide: () => Promise.reject(new Error("nothing is held")),
      hold: () => Promise.reject(new Error("nothing is held")),
      until: () => Promise.reject(new Error("nothing is held")),
    },
  };
}

test("a desktop job's intent check reads the owner's message verbatim and the job's task", async () => {
  const seen: IntentRequest[] = [];

  await open(undefined, undefined, {
    intent: recordingIntent(seen),
    origin: { kind: "owner" },
  });

  // Only the acting set_value is checked; capture observes.
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    ownerMessages: [
      { requestId: "req-1", text: "Fill in the form", from: "owner" },
    ],
    tasks: ["Fill the form with Ada."],
    action: {
      steps: [
        {
          action: "set_value",
          target: { role: "entry", name: "Name" },
          value: "Ada",
        },
      ],
    },
  });
});

test("a start citing a message that isn't the owner's is rejected and starts no job", async () => {
  const seen: IntentRequest[] = [];

  const { runtime, agent, chat } = await open(undefined, undefined, {
    intent: recordingIntent(seen),
    origin: { kind: "owner" },
    start: { owner_messages: ["req-1", "made-up"] },
    done: "The job did not start.",
  });

  const result = (await runtime.snapshot(agent, chat)).messages.find(
    (message) => message.toolName === "desktop",
  );

  expect(result?.content).toContain("Not owner messages of this chat: made-up");
  expect(await runtime.desktopJobs(agent)).toEqual([]);
  expect(seen).toEqual([]);
});

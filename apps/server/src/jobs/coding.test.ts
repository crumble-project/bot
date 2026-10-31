import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { createModels } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { codingEnv, codingExtensions } from "./coding";
import type { Agent } from "../shared/domain";
import { createAPI } from "../app/api";
import { codingJobsResponse, historyResponse } from "../contract/api-responses";
import { AgentRuntime } from "../bots/runtime";
import { standaloneScheduler } from "../schedules/scheduler";
import { standaloneBots } from "../bots/bots";
import { Store } from "../../test/support/store";
import type { Workspaces } from "../workspaces/workspace";
import { DesktopNotConfigured } from "../workspaces/workspace-errors";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A directory on this machine standing in for the VM boundary. */
class DirectoryWorkspaces implements Workspaces {
  readonly synced: string[] = [];
  readonly environments: ExecutionEnv[] = [];
  readonly desktop = false;

  constructor(readonly dir: string) {}

  env(_agentId: string) {
    const env = new NodeExecutionEnv({ cwd: this.dir });
    this.environments.push(env);

    return env;
  }

  sync(agentId: string) {
    return Effect.sync(() => void this.synced.push(agentId));
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

const messageText = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const call = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage(fauxToolCall(name, args), {
    stopReason: "toolUse",
  });

/** What a job's model answers next, told apart by the tool call it saw last. */
function jobReply(last: Message) {
  if (last.role === "user")
    return call("bash", { command: "echo hello > hello.txt" });

  if (last.role === "toolResult" && last.toolName === "bash")
    return call("write", { path: "notes.txt", content: "notes" });

  return fauxAssistantMessage([fauxText("Wrote hello.txt and notes.txt.")]);
}

/** What the bot's model answers next: start the job, or wrap up once it ran. */
function botReply(last: Message, text: string) {
  if (text.startsWith("[coding job"))
    return fauxAssistantMessage([fauxText("The job is finished.")]);

  if (last.role === "toolResult")
    return fauxAssistantMessage([fauxText("Started.")]);

  return call("coding", {
    action: "start",
    name: "builder",
    message: "Create the files.",
  });
}

/** One scripted model plays the bot and its jobs; the tools it was offered tell them apart. */
function script(
  options: {
    offered?: Map<"bot" | "job", string[]>;
    beforeJob?: (signal: AbortSignal | undefined) => Promise<void>;
  } = {},
): FauxResponseFactory {
  return async (context, streamOptions) => {
    const tools = context.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );

    const job = tools.includes("bash");
    options.offered?.set(job ? "job" : "bot", tools);

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    if (job) {
      await options.beforeJob?.(streamOptions?.signal);

      return jobReply(last);
    }

    return botReply(last, messageText(last));
  };
}

function setup(dir: string, tools: string[] = ["coding"]) {
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const agent = store.createAgent(
    {
      name: "Builder",
      avatar: "bot",
      description: "",
      instructions: "",
      provider: "faux",
      model: "chat",
      enabled: true,
      tools,
      skills: [],
      mcpServers: [],
      delegates: [],
    },
    "00000000-0000-4000-8000-000000000401",
  );

  return { store, agent };
}

function open(
  dir: string,
  workspaces: Workspaces,
  steps: FauxResponseFactory,
  agent: Agent,
) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(Array.from({ length: 40 }, () => steps));
  const models = createModels();
  models.setProvider(faux.provider);

  const coding = (current: Agent) =>
    current.tools.includes("coding")
      ? codingExtensions(current, workspaces)
      : { chat: [], job: [] };

  const runtime = new AgentRuntime(dir, {
    models,
    extensions: (current) => coding(current).chat,
    taskExtensions: (current) => coding(current).job,
    env: (agentId, target, context) =>
      codingEnv(workspaces, agentId, target, context),
  });

  return { runtime, agent };
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500 && !(await check()); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));

  expect(await check()).toBe(true);
}

const reports = async (runtime: AgentRuntime, agent: Agent, chat: string) =>
  (await runtime.snapshot(agent, chat)).messages.filter(
    (message) => message.origin?.kind === "coding",
  );

test("a coding job works in the workspace and reports to the bot's chat once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  const { agent } = setup(dir);
  const workspaces = new DirectoryWorkspaces(workspace);
  await Bun.write(join(workspace, ".keep"), "");
  const offered = new Map<"bot" | "job", string[]>();
  const { runtime } = open(dir, workspaces, script({ offered }), agent);
  cleanups.push(() => runtime.close());
  const chat = await runtime.openChat(agent);

  await runtime.submit(agent, chat, "Build it", "req-1");
  await until(async () => (await reports(runtime, agent, chat)).length === 1);

  const snapshot = await runtime.snapshot(agent, chat);
  await until(async () =>
    (await runtime.snapshot(agent, chat)).messages.some(
      (message) => message.content === "The job is finished.",
    ),
  );

  const report = (await reports(runtime, agent, chat))[0]!;
  expect(report.content).toBe("Wrote hello.txt and notes.txt.");
  expect(report.origin?.name).toBe("builder");

  // The job's own conversation stays out of the chat: its task and answer show only as the report.
  const contents = (await runtime.snapshot(agent, chat)).messages.map(
    (message) => message.content,
  );

  expect(contents).not.toContain("Create the files.");
  // Starting a job ends the bot's turn: the card says it, so no message follows.
  expect(contents).not.toContain("Started.");
  expect(
    contents.filter((content) => content === "Wrote hello.txt and notes.txt."),
  ).toHaveLength(1);
  expect(readFileSync(join(workspace, "hello.txt"), "utf8")).toBe("hello\n");
  expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("notes");

  // bash and write each synced the bot's workspace.
  expect(workspaces.synced).toEqual([agent.id, agent.id]);

  // The tool result tells clients which conversation is the job.
  const started = snapshot.messages.find(
    (message) => message.toolName === "coding",
  );

  expect(started?.toolDetails).toMatchObject({
    name: "builder",
    status: "working",
    conversationId: expect.stringContaining(`${agent.id}:`),
  });

  // The chat only has the job tool. The job has the coding tools and no job tool, delegation, or memory.
  expect(offered.get("bot")).toEqual(["coding"]);
  expect(offered.get("job")?.toSorted()).toEqual([
    "bash",
    "edit",
    "read",
    "write",
  ]);
});

test("a bot without the coding tool is offered none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { agent } = setup(dir, []);
  const offered = new Map<"bot" | "job", string[]>();

  const { runtime } = open(
    dir,
    new DirectoryWorkspaces(join(dir, "workspace")),
    (context, options, state, model) => {
      void script({ offered })(context, options, state, model);

      return fauxAssistantMessage([fauxText("Plain answer.")]);
    },
    agent,
  );

  cleanups.push(() => runtime.close());
  const chat = await runtime.openChat(agent);
  await runtime.submit(agent, chat, "Build it", "req-1");

  await until(async () =>
    (await runtime.snapshot(agent, chat)).messages.some(
      (message) => message.content === "Plain answer.",
    ),
  );

  expect(offered.get("bot")).toEqual([]);
  expect(existsSync(join(dir, "workspace"))).toBe(false);
});

test("a restart while a job works does not report twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  await Bun.write(join(workspace, ".keep"), "");
  const { agent } = setup(dir);
  const workspaces = new DirectoryWorkspaces(workspace);

  let working!: () => void;
  const started = new Promise<void>((resolve) => (working = resolve));

  const first = open(
    dir,
    workspaces,
    script({
      // The first process never lets the job's model answer; closing it aborts the request.
      beforeJob: (signal) => {
        working();

        return new Promise<void>((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        );
      },
    }),
    agent,
  );

  const chat = await first.runtime.openChat(agent);
  await first.runtime.submit(agent, chat, "Build it", "req-1");
  await started;
  await first.runtime.close();

  const second = open(dir, workspaces, script(), agent);
  cleanups.push(() => second.runtime.close());
  await second.runtime.openChat(agent);

  await until(async () =>
    (await second.runtime.snapshot(agent, chat)).messages.some(
      (message) => message.content === "The job is finished.",
    ),
  );

  expect(await reports(second.runtime, agent, chat)).toHaveLength(1);
  expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("notes");
});

const token = "t".repeat(40);

function serve(store: Store, runtime: AgentRuntime) {
  const service = standaloneBots(store, runtime);

  const scheduler = standaloneScheduler(store.runtime, (a, p, r, s) =>
    service.dispatch(a, p, r, s),
  );

  const app = createAPI(service, token, { scheduler });

  return (path: string) =>
    app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

test("clients list a bot's coding jobs and page through a job's work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  await Bun.write(join(workspace, ".keep"), "");
  const { store, agent } = setup(dir);

  const { runtime } = open(
    dir,
    new DirectoryWorkspaces(workspace),
    script(),
    agent,
  );

  cleanups.push(() => runtime.close());
  const get = serve(store, runtime);
  const chat = await runtime.openChat(agent);

  expect(
    await (await get(`/v1/agents/${agent.id}/coding-jobs`)).json(),
  ).toEqual({ jobs: [] });

  await runtime.submit(agent, chat, "Build it", "req-1");
  await until(async () => (await reports(runtime, agent, chat)).length === 1);

  const started = (await runtime.snapshot(agent, chat)).messages.find(
    (message) => message.toolName === "coding",
  );

  const list = async () =>
    codingJobsResponse.parse(
      await (await get(`/v1/agents/${agent.id}/coding-jobs`)).json(),
    );

  await until(async () => (await list()).jobs[0]?.status === "idle");

  const { jobs } = await list();

  expect(jobs).toEqual([
    {
      name: "builder",
      conversationId: expect.any(String),
      status: "idle",
      // The job's own spend, apart from the bot's chat.
      usage: { models: { "faux/chat": expect.any(Object) }, tools: {} },
    },
  ]);

  expect(started?.toolDetails).toMatchObject({
    conversationId: jobs[0]!.conversationId,
  });

  const history = async (query = "") =>
    historyResponse.parse(
      await (
        await get(`/v1/agents/${agent.id}/coding-jobs/builder/history${query}`)
      ).json(),
    );

  const all = await history();
  expect(all.hasMore).toBe(false);

  expect(all.messages[0]).toMatchObject({
    role: "user",
    content: "Create the files.",
  });

  expect(
    all.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolName),
  ).toEqual(["bash", "write"]);

  expect(all.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: "Wrote hello.txt and notes.txt.",
  });

  const newest = await history("?limit=2");
  expect(newest.hasMore).toBe(true);
  expect(newest.messages.at(-1)).toEqual(all.messages.at(-1)!);

  const older = await history(
    `?limit=100&before=${encodeURIComponent(newest.oldestEntryId!)}`,
  );

  expect([...older.messages, ...newest.messages]).toEqual(all.messages);

  // The chat transcript still leaves the job's work out.
  const chatHistory = historyResponse.parse(
    await (await get(`/v1/agents/${agent.id}/chat/history`)).json(),
  );

  expect(
    chatHistory.messages.some(
      (message) => message.content === "Create the files.",
    ),
  ).toBe(false);

  expect(
    (await get(`/v1/agents/${agent.id}/coding-jobs/missing/history`)).status,
  ).toBe(404);

  expect((await get(`/v1/agents/nobody/coding-jobs`)).status).toBe(404);

  expect(
    (await get(`/v1/agents/nobody/coding-jobs/builder/history`)).status,
  ).toBe(404);
});

test("a working coding job's history shows the steps it finished", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  await Bun.write(join(workspace, ".keep"), "");
  const { store, agent } = setup(dir);
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));

  const { runtime } = open(
    dir,
    new DirectoryWorkspaces(workspace),
    // The job's second model call waits, so the job stays working after its bash step.
    script({ beforeJob: async () => void (++calls === 2 && (await held)) }),
    agent,
  );

  cleanups.push(() => runtime.close());
  const get = serve(store, runtime);
  const chat = await runtime.openChat(agent);

  await runtime.submit(agent, chat, "Build it", "req-1");
  await until(() => calls === 2);

  const history = historyResponse.parse(
    await (
      await get(`/v1/agents/${agent.id}/coding-jobs/builder/history`)
    ).json(),
  );

  expect(history.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
  ]);

  release();
  await until(async () => (await reports(runtime, agent, chat)).length === 1);
});

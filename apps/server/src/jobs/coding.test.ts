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
import { codingJobOf, codingPlugin, codingQuestions } from "./coding";
import type { JobAsked } from "./jobs";
import {
  WORKSPACE_NOTES_FILE,
  WORKSPACE_NOTES_SECTION,
  WORKSPACE_SECTION,
} from "./workspace-notes";
import { conversationEnv, jobExtensions } from "../plugins/plugins";
import type { Agent } from "../shared/domain";
import { createAPI } from "../app/api";
import { codingJobsResponse, historyResponse } from "../contract/api-responses";
import { AgentRuntime, type RuntimeCallbacks } from "../bots/runtime";
import { standaloneScheduler } from "../schedules/scheduler";
import { standaloneBots } from "../bots/bots";
import { Store } from "../../test/support/store";
import type { AvailableSkill } from "../skills/skill-library";
import type { BotSkills } from "../skills/skills";
import type { Workspaces } from "../workspaces/workspace";
import { DesktopNotConfigured } from "../workspaces/workspace-errors";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Counts file reads, the only operation a prompt section makes; on a real backend each boots a stopped machine. */
class ReadCountingEnv extends NodeExecutionEnv {
  constructor(
    cwd: string,
    private readonly onRead: () => void,
  ) {
    super({ cwd });
  }

  override openBinaryReader(
    ...args: Parameters<NodeExecutionEnv["openBinaryReader"]>
  ) {
    this.onRead();

    return super.openBinaryReader(...args);
  }
}

/** A directory on this machine standing in for the VM boundary. */
class DirectoryWorkspaces implements Workspaces {
  readonly synced: string[] = [];
  reads = 0;
  /** Environments handed out, one per tool call or prompt render that asked. */
  envs = 0;
  readonly desktop = false;
  /** Whether the machine runs; the directory itself is always there. */
  machine = true;

  constructor(readonly dir: string) {}

  running(_agentId: string) {
    return this.machine;
  }

  env(_agentId: string): ExecutionEnv {
    this.envs++;

    return new ReadCountingEnv(this.dir, () => this.reads++);
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

  outdated() {
    return [];
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

  if (text === "Check it" || text === "Stop it")
    return call("coding", {
      action: text === "Check it" ? "status" : "stop",
      name: "builder",
    });

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
    /** The prompt sections each role's latest request had. */
    sections?: Map<"bot" | "job", Record<string, string | null>>;
    beforeJob?: (signal: AbortSignal | undefined) => Promise<void>;
  } = {},
): FauxResponseFactory {
  return async (context, streamOptions) => {
    const tools = context.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );

    const job = tools.includes("ask_owner");
    options.offered?.set(job ? "job" : "bot", tools);
    options.sections?.set(
      job ? "job" : "bot",
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

    if (job) {
      await options.beforeJob?.(streamOptions?.signal);

      return jobReply(last);
    }

    return botReply(last, messageText(last));
  };
}

function setup(dir: string, tools: string[] = ["coding"], instructions = "") {
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const agent = store.createAgent(
    {
      name: "Builder",
      avatar: "bot",
      description: "",
      instructions,
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
  callbacks: Pick<RuntimeCallbacks, "listMemory" | "skillLibrary"> = {},
) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(Array.from({ length: 40 }, () => steps));
  const models = createModels();
  models.setProvider(faux.provider);

  const kinds = codingPlugin(workspaces).jobKinds ?? [];

  const runtime = new AgentRuntime(dir, {
    ...callbacks,
    models,
    extensions: (current) => jobExtensions(kinds, current).chat,
    taskExtensions: (current) => jobExtensions(kinds, current).job,
    env: (current, target, context) =>
      conversationEnv(kinds, current, target, context),
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

  // The chat has the coding tools and the job tool. The job has the coding tools and no job tool, delegation, or memory.
  expect(offered.get("bot")).toEqual([
    "read",
    "write",
    "edit",
    "bash",
    "coding",
  ]);
  expect(offered.get("job")?.toSorted()).toEqual([
    "ask_owner",
    "bash",
    "edit",
    "read",
    "skill",
    "write",
  ]);
});

const releaseSkill: AvailableSkill = {
  id: "release",
  name: "Release",
  description: "Cut a release of the app",
  instructions: "Tag from main, never from a branch.",
  documents: [],
  scope: "own",
};

/** Skills the bot learned earlier; loading one counts as a use, as in the chat. */
function learnedSkills(used: string[]): BotSkills["Service"] {
  const unsupported = () => Effect.die(new Error("read-only library"));

  return {
    available: () => Effect.succeed([releaseSkill]),
    used: (_agent, skill) => Effect.sync(() => void used.push(skill.name)),
    own: () => Effect.succeed([]),
    create: unsupported,
    update: unsupported,
    remove: unsupported,
    transaction: (effect) => effect,
  };
}

test("a coding job starts with its bot's memory, skills, and latest chat, and nothing else of the chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  const { agent } = setup(dir, ["coding"], "Write commit messages in English.");
  await Bun.write(join(workspace, ".keep"), "");
  const offered = new Map<"bot" | "job", string[]>();
  const sections = new Map<"bot" | "job", Record<string, string | null>>();
  const used: string[] = [];
  const recorded = script({ offered, sections });

  // The job loads the bot's learned skill before it works; the bot acknowledges plain chat messages.
  const steps: FauxResponseFactory = async (context, ...rest) => {
    const reply = await recorded(context, ...rest);

    const job = context.messages.some(
      (message) =>
        message.role === "system" &&
        (message.toolsAdded ?? []).some((tool) => tool.name === "ask_owner"),
    );

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    if (job && last.role === "user")
      return call("skill", { action: "view", name: "Release" });

    return messageText(last) === "We release from the staging branch."
      ? fauxAssistantMessage([fauxText("Noted, staging it is.")])
      : reply;
  };

  const { runtime } = open(
    dir,
    new DirectoryWorkspaces(workspace),
    steps,
    agent,
    {
      listMemory: () => [
        { id: "own", content: "The owner deploys with Fly.io." },
        { id: "shared", content: "The team uses pnpm.", shared: true },
      ],
      skillLibrary: learnedSkills(used),
    },
  );

  cleanups.push(() => runtime.close());
  const chat = await runtime.openChat(agent);

  await runtime.wait(
    await runtime.submit(
      agent,
      chat,
      "We release from the staging branch.",
      "req-0",
    ),
    agent,
  );
  await runtime.submit(agent, chat, "Build it", "req-1");
  await until(async () => (await reports(runtime, agent, chat)).length === 1);

  const job = sections.get("job")!;

  expect(job["bot_knowledge"]).toContain("Write commit messages in English.");
  expect(job["bot_knowledge"]).toContain("- Release: Cut a release of the app");
  expect(job["bot_knowledge"]).toContain("- The owner deploys with Fly.io.");
  expect(job["bot_knowledge"]).toContain(
    "Shared memory (other agents see it too):\n- The team uses pnpm.",
  );
  expect(used).toEqual(["Release"]);

  // The chat's words reach the job; the bot's tool calls, such as the start that names the job, do not.
  expect(job["instructions"]).toContain(
    "Owner: We release from the staging branch.\n\nBot: Noted, staging it is.",
  );
  expect(job["instructions"]).toContain("Build it");
  expect(job["instructions"]).not.toContain("Create the files.");
  expect(job["instructions"]).not.toContain("builder");

  // The job can load skills but neither write them nor memory, nor start jobs; the chat keeps its own prompt.
  expect(offered.get("job")).toContain("skill");
  expect(offered.get("job")).not.toContain("skill_manage");
  expect(offered.get("job")).not.toContain("memory");
  expect(offered.get("job")).not.toContain("coding");
  expect(sections.get("bot")?.["bot_knowledge"] ?? null).toBeNull();

  // The job's transcript is its own work, not a copy of the chat.
  const history = await runtime.codingJobHistory(agent, "builder");

  expect(history.messages.map((message) => message.content)).not.toContain(
    "We release from the staging branch.",
  );
});

test("only starting a job shows its card in the chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  const { agent } = setup(dir);
  await Bun.write(join(workspace, ".keep"), "");

  const { runtime } = open(
    dir,
    new DirectoryWorkspaces(workspace),
    script(),
    agent,
  );

  cleanups.push(() => runtime.close());
  const chat = await runtime.openChat(agent);

  const answered = async (count: number) =>
    (await runtime.snapshot(agent, chat)).messages.filter(
      (message) => message.content === "Started.",
    ).length === count;

  await runtime.submit(agent, chat, "Build it", "req-1");
  await until(async () => (await reports(runtime, agent, chat)).length === 1);
  await runtime.submit(agent, chat, "Check it", "req-2");
  await until(() => answered(1));
  await runtime.submit(agent, chat, "Stop it", "req-3");
  await until(() => answered(2));

  const { messages } = await runtime.snapshot(agent, chat);
  const results = messages.filter((message) => message.toolName === "coding");

  expect(results.map((message) => codingJobOf(message))).toEqual([
    "builder",
    undefined,
    undefined,
  ]);
});

test("a bot without the coding tool is offered none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { agent } = setup(dir, []);
  const offered = new Map<"bot" | "job", string[]>();
  const workspaces = new DirectoryWorkspaces(join(dir, "workspace"));

  const { runtime } = open(
    dir,
    workspaces,
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
  // Not even an environment: nothing in the chat could reach the workspace.
  expect(workspaces.envs).toBe(0);
  expect(existsSync(join(dir, "workspace"))).toBe(false);
});

/** The bot itself writes a file when asked to, and records each request's tools and prompt sections. */
function directScript(
  offered: string[][],
  sections: Record<string, string | null>[],
): FauxResponseFactory {
  return async (context) => {
    offered.push(
      context.messages.flatMap((message) =>
        message.role === "system"
          ? (message.toolsAdded ?? []).map((tool) => tool.name)
          : [],
      ),
    );
    sections.push(
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

    if (last.role === "toolResult")
      return fauxAssistantMessage([fauxText("Done.")]);

    return messageText(last).includes("Write")
      ? call("write", { path: "direct.txt", content: "direct" })
      : fauxAssistantMessage([fauxText("Hi.")]);
  };
}

async function directWork() {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  await Bun.write(join(workspace, ".keep"), "");
  const { agent } = setup(dir);
  const workspaces = new DirectoryWorkspaces(workspace);
  const offered: string[][] = [];
  const sections: Record<string, string | null>[] = [];

  const { runtime } = open(
    dir,
    workspaces,
    directScript(offered, sections),
    agent,
  );

  cleanups.push(() => runtime.close());

  const say = async (conversation: string, text: string) =>
    runtime.wait(
      await runtime.submit(agent, conversation, text, `req-${text}`),
      agent,
    );

  return { runtime, agent, workspace, workspaces, offered, sections, say };
}

test("the bot works in its workspace itself, in its chat and group chats", async () => {
  const { runtime, agent, workspace, workspaces, offered, say } =
    await directWork();

  const chat = await runtime.openChat(agent);
  await say(chat, "Write it");

  expect(readFileSync(join(workspace, "direct.txt"), "utf8")).toBe("direct");
  expect(workspaces.synced).toEqual([agent.id]);
  expect(offered.at(-1)).toEqual(["read", "write", "edit", "bash", "coding"]);

  rmSync(join(workspace, "direct.txt"));
  const group = await runtime.openGroupConversation(agent, "group-1");
  await say(group, "Write it in the group");

  // A group turn has the workspace too, though no coding jobs.
  expect(readFileSync(join(workspace, "direct.txt"), "utf8")).toBe("direct");
  expect(workspaces.synced).toEqual([agent.id, agent.id]);
  expect(offered.at(-1)).toEqual(["read", "write", "edit", "bash", "pass"]);
});

test("the chat's prompt never boots a stopped workspace, and shows its notes while it runs", async () => {
  const { runtime, agent, workspace, workspaces, sections, say } =
    await directWork();

  await Bun.write(join(workspace, WORKSPACE_NOTES_FILE), "pnpm is at ~/bin.\n");
  workspaces.machine = false;
  const chat = await runtime.openChat(agent);
  await say(chat, "Hello");

  expect(workspaces.reads).toBe(0);
  expect(sections.at(-1)?.[WORKSPACE_SECTION]).toEndWith(
    "Its notes are in /workspace/.crumble/notes.md: read them before you work there.\n</workspace>",
  );

  workspaces.machine = true;
  await say(chat, "Hello again");

  expect(workspaces.reads).toBeGreaterThan(0);
  expect(sections.at(-1)?.[WORKSPACE_SECTION]).toContain(
    "kept in /workspace/.crumble/notes.md. Use them instead of rediscovering, and fix a line that proves wrong.\npnpm is at ~/bin.\nWhen you learn",
  );
  // The job's own notes section stays out of the chat.
  expect(sections.at(-1)?.[WORKSPACE_NOTES_SECTION] ?? null).toBeNull();
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

  return (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);

    headers.set("authorization", `Bearer ${token}`);

    return app.request(path, { ...init, headers });
  };
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
      model: { provider: "faux", model: "chat" },
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

/** A job that asks the owner first, then works with the answer. */
function askingScript(): FauxResponseFactory {
  return async (context) => {
    const tools = context.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    if (!tools.includes("ask_owner")) return botReply(last, messageText(last));

    if (last.role === "user" && messageText(last).includes("answered"))
      return fauxAssistantMessage([fauxText(`Used ${messageText(last)}`)]);

    return fauxAssistantMessage(
      fauxToolCall("ask_owner", {
        question: "Which color?",
        options: ["blue", "red"],
        multiple: true,
      }),
      { stopReason: "toolUse" },
    );
  };
}

test("a job's question waits through a restart, and the owner's answer resumes the job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  await Bun.write(join(workspace, ".keep"), "");
  const { store, agent } = setup(dir);
  const workspaces = new DirectoryWorkspaces(workspace);

  const first = open(dir, workspaces, askingScript(), agent);
  const chat = await first.runtime.openChat(agent);
  await first.runtime.submit(agent, chat, "Build it", "req-1");

  await until(
    async () =>
      (await first.runtime.codingJobs(agent))[0]?.question !== undefined,
  );

  const cards = (await first.runtime.snapshot(agent, chat)).messages.filter(
    (message) => message.kind === "job-question",
  );

  expect(cards.map((card) => card.content)).toEqual(["Which color?"]);
  expect(await reports(first.runtime, agent, chat)).toHaveLength(0);
  await first.runtime.close();

  const second = open(dir, workspaces, askingScript(), agent);
  cleanups.push(() => second.runtime.close());
  await second.runtime.openChat(agent);
  const [job] = await second.runtime.codingJobs(agent);

  expect(job?.question).toMatchObject({
    text: "Which color?",
    options: ["blue", "red"],
    multiple: true,
  });
  expect(cards[0]?.jobQuestion?.options).toEqual(["blue", "red"]);
  const request = serve(store, second.runtime);

  const answer = (questionId: string, text: string) =>
    request(`/v1/agents/${agent.id}/coding-jobs/builder/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId, text }),
    });

  expect((await answer("older", "red")).status).toBe(409);
  expect((await answer(job!.question!.id, "blue")).status).toBe(204);

  await until(async () =>
    (await second.runtime.snapshot(agent, chat)).messages.some(
      (message) => message.content === "The job is finished.",
    ),
  );
  expect((await second.runtime.codingJobs(agent))[0]?.question).toBeUndefined();
  expect(
    (await reports(second.runtime, agent, chat)).map(
      (message) => message.content,
    ),
  ).toEqual(["Used The owner answered your question: blue"]);
});

test("a job keeps the bot turn that sent its work through a restart, until its report is answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  await Bun.write(join(workspace, ".keep"), "");
  const { agent } = setup(dir);
  const workspaces = new DirectoryWorkspaces(workspace);
  const asked: JobAsked[] = [];

  cleanups.push(codingQuestions(async (question) => void asked.push(question)));

  const first = open(dir, workspaces, askingScript(), agent);
  const chat = await first.runtime.openChat(agent);
  const turn = await first.runtime.submit(agent, chat, "Build it", "req-1");

  await until(
    async () =>
      (await first.runtime.codingJobs(agent))[0]?.question !== undefined,
  );
  await until(async () => asked.length === 1);
  expect(asked[0]).toMatchObject({ agentId: agent.id, name: "builder" });
  expect(asked[0]?.turn).toEqual([turn]);
  await first.runtime.close();

  const second = open(dir, workspaces, askingScript(), agent);
  cleanups.push(() => second.runtime.close());
  await second.runtime.openChat(agent);

  // The question keeps the turn's work open; nothing has reported yet.
  expect(await second.runtime.turnWork(agent, turn)).toEqual({
    open: true,
    reports: [],
  });
  const [job] = await second.runtime.codingJobs(agent);

  expect(
    await second.runtime.answerCodingJob(agent, {
      name: "builder",
      questionId: job!.question!.id,
      text: "blue",
    }),
  ).toBe(true);

  await until(
    async () => (await second.runtime.turnWork(agent, turn))?.open === false,
  );
  const work = await second.runtime.turnWork(agent, turn);

  expect(work?.reports).toHaveLength(1);
  expect(await second.runtime.response(agent, chat, work!.reports[0]!)).toEqual(
    ["The job is finished."],
  );
});

/** Runs one job in a workspace with `notes` as its workspace notes, if any; returns each role's prompt sections. */
async function promptSections(notes?: string) {
  const dir = mkdtempSync(join(tmpdir(), "bot-coding-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  const { agent } = setup(dir);
  await Bun.write(join(workspace, ".keep"), "");

  if (notes !== undefined)
    await Bun.write(join(workspace, WORKSPACE_NOTES_FILE), notes);

  const sections = new Map<"bot" | "job", Record<string, string | null>>();

  const { runtime } = open(
    dir,
    new DirectoryWorkspaces(workspace),
    script({ sections }),
    agent,
  );

  cleanups.push(() => runtime.close());
  const chat = await runtime.openChat(agent);
  await runtime.submit(agent, chat, "Build it", "req-1");
  await until(async () =>
    (await runtime.snapshot(agent, chat)).messages.some(
      (message) => message.content === "The job is finished.",
    ),
  );

  return sections;
}

test("a coding job's prompt has the workspace notes and asks to keep them; the bot's chat has none", async () => {
  const sections = await promptSections(
    "oxlint needs vm.max_map_count=262144.\n",
  );

  const notes = sections.get("job")?.[WORKSPACE_NOTES_SECTION];

  expect(notes).toStartWith(
    [
      "<workspace_notes>",
      "Facts earlier jobs of this bot learned about this workspace, kept in /workspace/.crumble/notes.md. Use them instead of rediscovering, and fix a line that proves wrong.",
      "oxlint needs vm.max_map_count=262144.",
      "When you learn something a later job would otherwise rediscover",
    ].join("\n"),
  );
  expect(notes).toContain("never write secrets in them.");
  expect(sections.get("bot")?.[WORKSPACE_NOTES_SECTION] ?? null).toBeNull();
});

test("a coding job in a workspace without notes is told where to start them", async () => {
  const sections = await promptSections();

  expect(sections.get("job")?.[WORKSPACE_NOTES_SECTION]).toStartWith(
    "<workspace_notes>\nNo notes yet: jobs of this bot keep facts about this workspace in /workspace/.crumble/notes.md. When you learn",
  );
});

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { Context, Effect, Layer, Scope } from "effect";
import { inertCredentials } from "../../test/support/job-wiring";
import { DirectoryWorkspaces } from "../../test/support/jobs";
import { testAPI, testVoiceGateway } from "../../test/support/api";
import { codingPlugin } from "../jobs/coding";
import { jobNeeds } from "../app/job-wiring";
import { conversationEnv, jobExtensions, Plugins } from "../plugins/plugins";
import { CallRequests } from "../voice-gateway/call-requests";
import { VoiceGateway } from "../voice-gateway/voice-gateway";
import { startServer } from "../app/server";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";
import { Store } from "../../test/support/store";
import type { Runner } from "../shared/runner";
import { until } from "../../test/support/until";
import { ScheduleRepository } from "../automations/schedule-repository";
import { HeldActions } from "../bot-desktop/held-actions";
import { BotRequests } from "../bot-requests/bot-requests";
import { BotSecretRequests } from "../bot-secrets/bot-secret-requests";
import { agentInput } from "../contract/agents";
import { scheduleInput } from "../contract/schedules";
import { MARK_QUESTION_TOOL_NAME } from "../contract/tools";
import { scheduleRequest } from "../shared/request-ids";
import { standaloneBots } from "./bots-test-support";
import { markQuestionExtension } from "./mark-question";
import { AgentRuntime } from "./runtime";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";

setDefaultTimeout(30_000);

const token = "t".repeat(40);
const dirs: Array<string> = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) {
    await closers.pop()!();
  }

  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

type CoreNeeds = Store["runtime"] extends Runner<infer R> ? R : never;

type StatusFrame = { agentId: string; status: string };

type SetupOptions = {
  extensions?: Array<Extension>;
  jobs?: boolean;
  tokensPerSecond?: number;
};

function setup(responses: Array<FauxResponseStep>, options: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bot-status-"));
  dirs.push(dir);

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "chat", input: ["text"] }],
    ...(options.tokensPerSecond && {
      tokensPerSecond: options.tokensPerSecond,
    }),
  });

  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);

  const store = new Store(dir);
  mkdirSync(join(dir, "workspace"));

  const plugin = codingPlugin(
    new DirectoryWorkspaces(join(dir, "workspace")),
    () => 900_000,
    inertCredentials,
  );

  const kinds = options.jobs ? (plugin.jobKinds ?? []) : [];

  const service = standaloneBots(
    store,
    new AgentRuntime(
      dir,
      runtimeCallbacks({
        models,
        extensions: (agent) => [
          markQuestionExtension(),
          ...(options.extensions ?? []),
          ...jobExtensions(kinds, agent).chat,
        ],
        jobExtensions: (agent) => jobExtensions(kinds, agent).job,
        env: (agent, target, context) =>
          conversationEnv(kinds, agent, target, context),
      }),
    ),
  );

  if (options.jobs) {
    service.effects.runSync(
      Layer.buildWithScope(
        jobNeeds.pipe(Layer.provide(Layer.succeed(Plugins, [plugin]))),
        Scope.makeUnsafe(),
      ),
    );
  }

  const callRequests = () =>
    service.effects.runSync(
      Layer.buildWithScope(
        CallRequests.layer.pipe(
          Layer.provide(
            Layer.succeed(VoiceGateway, testVoiceGateway(store.runtime)),
          ),
        ),
        Scope.makeUnsafe(),
      ).pipe(Effect.map(Context.get(CallRequests))),
    );

  closers.push(() => service.close());

  const app = testAPI(service, token);

  const bot = (name: string, tools: Array<string> = []) =>
    store.createAgent({
      name,
      description: "",
      instructions: "Answer",
      provider: "faux",
      model: "chat",
      enabled: true,
      tools,
      skills: [],
      mcpServers: [],
      delegates: [],
    });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });

  const say = (agentId: string, content: string) =>
    request(`/v1/agents/${agentId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, requestId: crypto.randomUUID() }),
    });

  const statusOf = async (agentId: string) => {
    const listed: Array<{ id: string; status: string }> = await (
      await request("/v1/agents")
    ).json();

    return listed.find((each) => each.id === agentId)?.status;
  };

  const core = store.runtime;

  const built = <I, S extends object>(
    layer: Layer.Layer<I, never, CoreNeeds>,
    key: Context.Key<I, S>,
  ): S =>
    core.runSync(
      Layer.buildWithScope(layer, Scope.makeUnsafe()).pipe(
        Effect.map(Context.get(key)),
      ),
    );

  return {
    app,
    bot,
    request,
    say,
    statusOf,
    service,
    store,
    core,
    built,
    callRequests,
  };
}

async function watch(app: {
  request: (path: string, init: RequestInit) => any;
}) {
  const response: Response = await app.request("/v1/events", {
    headers: { authorization: `Bearer ${token}` },
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<StatusFrame> = [];
  let buffer = "";

  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const [event, data] = part.split("\n");

        if (event === "event: bot-status" && data) {
          frames.push(JSON.parse(data.slice("data: ".length)));
        }
      }
    }
  })();

  closers.push(async () => {
    await reader.cancel();
    await reading;
  });

  const of = (agentId: string) =>
    frames.filter((frame) => frame.agentId === agentId).map((f) => f.status);

  return { frames, of };
}

const noRepeats = (statuses: Array<string>) =>
  statuses.every((status, index) => status !== statuses[index - 1]);

const toolCall = (name: string) =>
  fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" });

describe("bot status over HTTP", () => {
  test("lists a status for every bot and replays it when the stream connects", async () => {
    const { app, bot, statusOf } = setup([]);
    const first = bot("First");
    const second = bot("Second");

    expect(await statusOf(first.id)).toBe("idle");
    expect(await statusOf(second.id)).toBe("idle");

    const events = await watch(app);
    await until(
      () => events.of(first.id).length > 0 && events.of(second.id).length > 0,
    );

    expect(events.of(first.id)).toEqual(["idle"]);
    expect(events.of(second.id)).toEqual(["idle"]);
  });

  test("a chat question turns the bot to question until the owner answers", async () => {
    const { app, bot, say, statusOf, service, store } = setup([
      toolCall(MARK_QUESTION_TOOL_NAME),
      fauxAssistantMessage("Which database should I use?"),
      fauxAssistantMessage("Inbox is empty."),
      fauxAssistantMessage("Postgres it is."),
    ]);

    const agent = bot("Asker");
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    expect((await say(agent.id, "Set up storage")).status).toBeLessThan(300);
    await until(() => events.of(agent.id).includes("question"));
    expect(await statusOf(agent.id)).toBe("question");

    const schedule = store.runtime.runSync(
      Effect.gen(function* () {
        return yield* (yield* ScheduleRepository).create(
          scheduleInput.parse({
            agentId: agent.id,
            name: "Inbox check",
            prompt: "Check the inbox",
            cron: "0 * * * *",
          }),
          null,
        );
      }),
    );

    const settledAt = events.of(agent.id).length;

    const run = await service.dispatch(
      agent.id,
      schedule.prompt,
      scheduleRequest(schedule.id, "2026-11-14T08:00:00.000Z"),
      schedule.id,
    );

    await until(() => {
      const status = store.getExecution(run.id)?.status;

      return status !== "pending" && status !== "running";
    });
    expect(await statusOf(agent.id)).toBe("question");
    await Bun.sleep(300);
    expect(events.of(agent.id).slice(settledAt)).toEqual([]);

    expect((await say(agent.id, "Postgres")).status).toBeLessThan(300);
    await until(async () => (await statusOf(agent.id)) === "idle");
    await until(() => events.of(agent.id).at(-1) === "idle");

    const seen = events.of(agent.id);
    expect(seen.indexOf("question")).toBeGreaterThan(0);
    expect(seen.filter((status) => status === "question")).toHaveLength(1);
    expect(noRepeats(seen)).toBe(true);
  });

  test("a bot request blocks the bot until the owner answers", async () => {
    const { app, bot, statusOf, built, core } = setup([
      fauxAssistantMessage("Thanks, noted."),
    ]);

    const agent = bot("Requester");
    const requests = built(BotRequests.layer, BotRequests);
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    const asked = await core.runPromise(
      requests.request(agent.id, {
        proposal: agentInput.parse({ name: "Helper" }),
        reason: "I need help",
      }),
    );

    await until(() => events.of(agent.id).includes("blocked"));
    expect(await statusOf(agent.id)).toBe("blocked");

    await core.runPromise(requests.decline(agent.id, asked.id));
    await until(async () => (await statusOf(agent.id)) === "idle");
    await until(() => events.of(agent.id).at(-1) === "idle");

    expect(events.of(agent.id)[0]).toBe("idle");
    expect(events.of(agent.id)).toContain("blocked");
    expect(noRepeats(events.of(agent.id))).toBe(true);
  });

  test("a credential request and a held action block the bot, each ending when answered", async () => {
    const { app, bot, statusOf, core } = setup([
      fauxAssistantMessage("Thanks, noted."),
    ]);

    const agent = bot("Waiting");
    const other = bot("Bystander");
    const secrets = core.runSync(
      Effect.flatMap(BotSecretRequests, Effect.succeed),
    );
    const held = core.runSync(Effect.flatMap(HeldActions, Effect.succeed));
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    const action = await core.runPromise(
      held.hold({
        agentId: agent.id,
        job: "desk",
        action: "Click buy",
        page: null,
        ownerMessages: [],
        reason: "Spends money",
      }),
    );

    await until(() => events.of(agent.id).includes("blocked"));
    expect(await statusOf(agent.id)).toBe("blocked");

    await core.runPromise(
      secrets.ask(agent.id, "credential", {
        name: "api",
        hosts: ["example.com"],
        reason: "Needs the API",
      }),
    );
    await core.runPromise(
      held.decide(agent.id, action.id, { status: "approved" }),
    );
    expect(await statusOf(agent.id)).toBe("blocked");

    await core.runPromise(secrets.decline(agent.id, "credential", "api"));
    await until(async () => (await statusOf(agent.id)) === "idle");
    await until(() => events.of(agent.id).at(-1) === "idle");

    expect(noRepeats(events.of(agent.id))).toBe(true);
    expect(events.of(other.id)).toEqual(["idle"]);
  });

  test("a failed turn shows as failed until the next turn succeeds", async () => {
    const { app, bot, say, statusOf } = setup([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
      fauxAssistantMessage("Back again."),
    ]);

    const agent = bot("Flaky");
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    await say(agent.id, "Try something");
    await until(async () => (await statusOf(agent.id)) === "failed");
    await until(() => events.of(agent.id).at(-1) === "failed");

    await say(agent.id, "Try again");
    await until(async () => (await statusOf(agent.id)) === "idle");
    await until(() => events.of(agent.id).at(-1) === "idle");

    expect(events.of(agent.id)).toContain("failed");
    expect(noRepeats(events.of(agent.id))).toBe(true);
  });
});

const messageText = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const call = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function gate() {
  let open!: () => void;

  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { opened, open };
}

function jobScript(work: Promise<void>): Array<FauxResponseFactory> {
  const step: FauxResponseFactory = async (context) => {
    const tools = context.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    const text = messageText(last);

    if (tools.includes("ask_owner")) {
      if (last.role === "user" && text.includes("answered")) {
        return fauxAssistantMessage([fauxText("Used the answer.")]);
      }

      if (text === "ask") {
        return call("ask_owner", { question: "Which color?" });
      }
      await work;

      return fauxAssistantMessage([fauxText("Worked.")]);
    }

    if (text.startsWith("[coding job")) {
      return fauxAssistantMessage([fauxText("The job is finished.")]);
    }

    if (text.includes("Start work") || text.includes("Start asking")) {
      return call("coding", {
        action: "start",
        name: "builder",
        message: text.includes("Start work") ? "work" : "ask",
      });
    }

    if (text.includes("Stop it")) {
      return call("coding", { action: "stop", name: "builder" });
    }

    return fauxAssistantMessage([fauxText("Okay.")]);
  };

  return Array.from({ length: 40 }, () => step);
}

const askedQuestion = async (
  request: (path: string, init?: RequestInit) => Promise<Response> | Response,
  agentId: string,
) => {
  const listed = (await (
    await request(`/v1/agents/${agentId}/coding-jobs`)
  ).json()) as { jobs: Array<{ name: string; question?: { id: string } }> };

  return listed.jobs[0]?.question;
};

const answer = (
  request: (path: string, init?: RequestInit) => Promise<Response> | Response,
  agentId: string,
  questionId: string,
) =>
  request(`/v1/agents/${agentId}/coding-jobs/builder/answer`, {
    method: "POST",
    body: JSON.stringify({ questionId, text: "blue" }),
  });

describe("bot status from jobs, calls and polling", () => {
  test("a working job keeps the bot working until it reports", async () => {
    const work = gate();
    const { app, bot, say, statusOf } = setup(jobScript(work.opened), {
      jobs: true,
    });
    const agent = bot("Builder", ["coding"]);
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    await say(agent.id, "Start work");
    await until(() => events.of(agent.id).includes("working"));
    await Bun.sleep(1500);
    expect(await statusOf(agent.id)).toBe("working");
    expect(events.of(agent.id).at(-1)).toBe("working");

    work.open();
    await until(async () => (await statusOf(agent.id)) === "idle");
    await until(() => events.of(agent.id).at(-1) === "idle");
    expect(noRepeats(events.of(agent.id))).toBe(true);
  });

  test("a job's question turns the bot to question until it is answered", async () => {
    const work = gate();

    const { app, bot, say, statusOf, request } = setup(jobScript(work.opened), {
      jobs: true,
    });
    const agent = bot("Builder", ["coding"]);
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    await say(agent.id, "Start asking");
    await until(() => events.of(agent.id).at(-1) === "question");
    await Bun.sleep(1200);
    expect(await statusOf(agent.id)).toBe("question");
    const question = await askedQuestion(request, agent.id);
    expect(question).toBeDefined();

    expect((await answer(request, agent.id, question!.id)).status).toBe(204);
    await until(async () => (await statusOf(agent.id)) === "idle");
    await until(() => events.of(agent.id).at(-1) === "idle");
    expect(noRepeats(events.of(agent.id))).toBe(true);
  });

  test("a job stopped with a pending question still lists it and can still be answered", async () => {
    const work = gate();

    const { app, bot, say, statusOf, request, store } = setup(
      jobScript(work.opened),
      { jobs: true },
    );
    const agent = bot("Builder", ["coding"]);
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    await say(agent.id, "Start asking");
    await until(() => events.of(agent.id).at(-1) === "question");
    const question = await askedQuestion(request, agent.id);

    const stopping = await (await say(agent.id, "Stop it")).json();
    await until(() => {
      const status = store.getExecution(stopping.id)?.status;

      return status === "done" || status === "failed";
    });
    await Bun.sleep(500);

    expect(await askedQuestion(request, agent.id)).toEqual(question);
    expect(await statusOf(agent.id)).toBe("question");

    expect((await answer(request, agent.id, question!.id)).status).toBe(204);
    await until(async () => (await statusOf(agent.id)) === "idle");
  });

  test("a pending call request blocks the bot until the owner answers", async () => {
    const { app, bot, statusOf, callRequests, core } = setup([
      fauxAssistantMessage("Understood."),
    ]);
    const agent = bot("Caller");
    const calls = callRequests();
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    const asked = await core.runPromise(
      calls.request(agent.id, {
        number: "+49307654321",
        callee: "Dentist",
        goal: "Book a visit",
        opening: "Hello",
      }),
    );

    await until(() => events.of(agent.id).includes("blocked"));
    expect(await statusOf(agent.id)).toBe("blocked");

    await core.runPromise(calls.decline(agent.id, asked.id));
    await until(async () => (await statusOf(agent.id)) === "idle");
    await until(() => events.of(agent.id).at(-1) === "idle");
    expect(noRepeats(events.of(agent.id))).toBe(true);
  });

  test("the poll moves a running turn from thinking to working", async () => {
    const thought = gate();

    const { app, bot, say, statusOf } = setup(
      [
        async () => {
          await thought.opened;

          return fauxAssistantMessage(
            Array.from({ length: 24 }, (_, index) => `word${index}`).join(" "),
          );
        },
      ],
      { tokensPerSecond: 10 },
    );

    const agent = bot("Thinker");
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    await say(agent.id, "Go");
    await until(() => events.of(agent.id).includes("thinking"));
    expect(events.of(agent.id)).not.toContain("working");

    thought.open();
    await until(() => events.of(agent.id).at(-1) === "working");
    expect(await statusOf(agent.id)).toBe("working");

    await until(() => events.of(agent.id).at(-1) === "idle");
    expect(events.of(agent.id)).toEqual([
      "idle",
      "thinking",
      "working",
      "idle",
    ]);
  });

  test("a question written in the message that marks it counts", async () => {
    const { app, bot, say, statusOf } = setup([
      fauxAssistantMessage(
        [
          fauxText("Which database?"),
          fauxToolCall(MARK_QUESTION_TOOL_NAME, {}),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(""),
    ]);

    const agent = bot("Asker");
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    await say(agent.id, "Set up storage");
    await until(() => events.of(agent.id).at(-1) === "question");
    expect(await statusOf(agent.id)).toBe("question");
  });
});

describe("bot status ordering", () => {
  test("a slow computation never overwrites a newer status", async () => {
    const { app, bot, say, statusOf, service, core } = setup([
      fauxAssistantMessage("Hello."),
    ]);

    const agent = bot("Slow");
    const held = core.runSync(Effect.flatMap(HeldActions, Effect.succeed));
    const events = await watch(app);
    await until(() => events.of(agent.id).length > 0);

    await say(agent.id, "Hi");
    await until(async () => (await statusOf(agent.id)) === "idle");
    await until(() => events.of(agent.id).at(-1) === "idle");

    const hold = () =>
      core.runPromise(
        held.hold({
          agentId: agent.id,
          job: "desk",
          action: "Click",
          page: null,
          ownerMessages: [],
          reason: "Spends money",
        }),
      );

    const first = await hold();
    await until(() => events.of(agent.id).at(-1) === "blocked");

    const real = service.runtime.snapshot.bind(service.runtime);
    let slow = true;

    service.runtime.snapshot = async (...args) => {
      const read = await real(...args);

      if (slow) {
        slow = false;
        await Bun.sleep(600);
      }

      return read;
    };

    await core.runPromise(
      held.decide(agent.id, first.id, { status: "approved" }),
    );
    await until(() => !slow);
    await hold();

    await Bun.sleep(1200);
    expect(await statusOf(agent.id)).toBe("blocked");
    expect(events.of(agent.id).at(-1)).toBe("blocked");
    expect(noRepeats(events.of(agent.id))).toBe(true);
  });
});

describe("bot status across accounts", () => {
  test("another account's stream never sees a bot's status", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bot-status-accounts-"));
    dirs.push(dataDir);
    const running = await startServer({ dataDir, port: 0 });
    closers.push(() => running.close());

    const signUp = async (suffix: string) => {
      const response = await fetch(
        new URL("/api/auth/sign-up/email", running.server.url),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `Test ${suffix}`,
            email: `${suffix}@example.test`,
            password: "correct horse battery staple",
          }),
        },
      );

      const body = (await response.json()) as { token: string };

      return { authorization: `Bearer ${body.token}` };
    };

    const first = await signUp(`first-${crypto.randomUUID()}`);
    const second = await signUp(`second-${crypto.randomUUID()}`);

    const json = (headers: Record<string, string>) => ({
      ...headers,
      "content-type": "application/json",
    });

    const url = (path: string) => new URL(path, running.server.url);

    const created = await fetch(url("/v1/agents"), {
      method: "POST",
      headers: json(first),
      body: JSON.stringify({ name: "Private bot" }),
    });

    const agent = (await created.json()) as { id: string };

    const streams = await Promise.all(
      [first, second].map(async (headers) => {
        const frames: Array<StatusFrame> = [];
        const response = await fetch(url("/v1/events"), { headers });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        const reading = (async () => {
          let buffer = "";

          for (;;) {
            const { value, done } = await reader.read();

            if (done) {
              return;
            }
            buffer += decoder.decode(value, { stream: true });

            for (const match of buffer.matchAll(
              /event: bot-status\ndata: (.*)\n\n/g,
            )) {
              frames.push(JSON.parse(match[1]!));
            }
            buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
          }
        })();

        closers.push(async () => {
          await reader.cancel();
          await reading;
        });

        return frames;
      }),
    );

    const [owned, foreign] = streams;
    await until(() => owned!.some((frame) => frame.agentId === agent.id));

    await fetch(url(`/v1/agents/${agent.id}/messages`), {
      method: "POST",
      headers: json(first),
      body: JSON.stringify({
        content: "hello",
        requestId: crypto.randomUUID(),
      }),
    });
    await until(() => owned!.some((frame) => frame.status !== "idle"));
    await Bun.sleep(300);

    expect(foreign).toEqual([]);

    const secondList = await fetch(url("/v1/agents"), { headers: second });
    expect(await secondList.json()).toEqual([]);
  });
});

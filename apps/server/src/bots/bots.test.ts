import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentInput, type Agent } from "../contract/agents";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { CoreServices } from "../app/core-layer";
import { Store } from "../../test/support/store";
import { until } from "../../test/support/until";
import { standaloneBots } from "./bots-test-support";
import { Bots } from "./bots";
import { AgentRuntime, BotRuntime } from "./runtime";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-bots-"));
  dirs.push(dir);

  return dir;
};

type RuntimeFixture = {
  openChat?: () => Promise<string>;
  prepareInput?: (
    agent: Agent,
    text: string,
  ) => Promise<{ modelContent: string; data: { text: string } }>;
  submit?: () => Promise<string>;
  abort?: () => Promise<void>;
  wait?: () => Promise<{ status: "done" }>;
};

const fakeRuntime = (fixture: RuntimeFixture) =>
  // SAFETY: The prototype supplies AgentRuntime identity; the fixture overrides the methods a test uses.
  Object.assign(
    Object.create(AgentRuntime.prototype),
    { close: async () => undefined },
    fixture,
  ) as AgentRuntime;

test("closing the bots leaves the runtime to the layer that opened it", async () => {
  const store = new Store(make());
  let closes = 0;

  const counted = Object.assign(fakeRuntime({}), {
    close: async () => {
      closes += 1;
    },
  });

  const runtime = Layer.effect(
    BotRuntime,
    Effect.acquireRelease(Effect.succeed(counted), (opened) =>
      Effect.promise(() => opened.close()),
    ),
  );

  const dependencies = Layer.succeedContext(
    store.runtime.runSync(Effect.context<CoreServices>()),
  );

  const bots = ManagedRuntime.make(
    Bots.layer.pipe(Layer.provide(runtime), Layer.provide(dependencies)),
  );

  await bots.runPromise(Bots.use(() => Effect.void));
  await bots.dispose();
  store.close();

  expect(closes).toBe(1);
});

test("concurrent first uses of a bot's chat open one chat", async () => {
  const store = new Store(make());
  const agent = store.createAgent(agentInput.parse({ name: "Ada" }));
  let opened = 0;

  const bots = standaloneBots(
    store,
    fakeRuntime({
      openChat: async () => {
        opened += 1;
        await Bun.sleep(10);

        return `${agent.id}:1`;
      },
    }),
  );

  const chats = await Promise.all([
    bots.chat(agent.id),
    bots.chat(agent.id),
    bots.chat(agent.id),
  ]);

  expect(opened).toBe(1);
  expect(new Set(chats.map((chat) => chat.id)).size).toBe(1);
  await bots.close();
});

test("a failed admission leaves an execution cancelled meanwhile cancelled", async () => {
  const store = new Store(make());
  const agent = store.createAgent(agentInput.parse({ name: "Ada" }));
  const submitting = Promise.withResolvers<void>();
  const submission = Promise.withResolvers<string>();

  const bots = standaloneBots(
    store,
    fakeRuntime({
      openChat: async () => `${agent.id}:1`,
      prepareInput: async (_agent, text) => ({
        modelContent: text,
        data: { text },
      }),
      submit: () => {
        submitting.resolve();

        return submission.promise;
      },
      abort: async () => undefined,
    }),
  );

  const settled: string[] = [];
  bots.onSettled((execution) => void settled.push(execution.status));

  const sending = bots.sendChat(agent.id, "hello", "request-1");
  await submitting.promise;
  await bots.abort((await bots.chat(agent.id)).id);
  submission.reject(new Error("The harness went away"));
  await sending.catch(() => undefined);

  const [execution] = store.listExecutions(agent.id);

  expect(execution?.status).toBe("cancelled");
  expect(execution?.error).toBeNull();
  expect(settled).toEqual(["cancelled"]);
  await bots.close();
});

test("closing stops waiting for outcomes, and the next start finishes them", async () => {
  const dir = make();
  const store = new Store(dir);
  const agent = store.createAgent(agentInput.parse({ name: "Ada" }));
  const answered = Promise.withResolvers<{ status: "done" }>();

  const first = standaloneBots(
    store,
    fakeRuntime({
      openChat: async () => `${agent.id}:1`,
      prepareInput: async (_agent: Agent, text: string) => ({
        modelContent: text,
        data: { text },
      }),
      submit: async () => "1",
      wait: () => new Promise<never>(() => {}),
    }),
  );

  const execution = await first.sendChat(agent.id, "hello", "request-1");
  expect(execution.status).toBe("running");
  await first.close();

  const reopened = new Store(dir);
  expect(reopened.getExecution(execution.id)?.status).toBe("running");

  const second = standaloneBots(
    reopened,
    fakeRuntime({ wait: () => answered.promise }),
  );

  await second.recover();
  answered.resolve({ status: "done" });
  await until(() => reopened.getExecution(execution.id)?.status === "done");
  await second.close();
});

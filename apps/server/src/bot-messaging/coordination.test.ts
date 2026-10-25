import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../shared/store";
import { standaloneBots } from "../bots/bots";
import { coordinationExtension } from "./coordination";
import { standaloneMessaging } from "./bot-messaging";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const input = (name: string, delegates: string[] = [], enabled = true) => ({
  name,
  avatar: "sparkles",
  description: "",
  instructions: "",
  provider: "openai" as const,
  model: "gpt-4.1",
  enabled,
  tools: ["delegate"],
  skills: [],
  mcpServers: [],
  delegates,
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bot-coordination-"));
  dirs.push(dir);
  let conversationNumber = 500;

  const runtime: any = {
    recordBotMessage: async () => {},
    openChat: async (agent: { id: string }) =>
      `${agent.id}:${++conversationNumber}`,
    submit: async (
      _agent: { id: string },
      _conversation: string,
      _prompt: string,
      requestId: string,
    ) => `submission:${requestId}`,
    // Delegated work stays running so recursion checks see it in flight.
    wait: () => new Promise(() => {}),
    response: async () => ["result"],
  };

  const store = new Store(dir);
  const service = standaloneBots(store, runtime);

  return { store, service };
}

const tool = (
  service: ReturnType<typeof standaloneBots>,
  agentId: string,
  index: number,
) => {
  const extension = coordinationExtension(
    service.agent(agentId),
    standaloneMessaging(service),
  );
  // SAFETY: The coordination extension always exposes its registered tools.

  return (extension as any).tools[index];
};

const invoke = (
  t: any,
  args: any,
  conversationId: string | number = 900,
  taskId = "task-1",
) => t.execute(args, { conversationId, taskId });

describe("coordination extension", () => {
  test("refuses self-targets and disabled targets", async () => {
    const { store, service } = setup();
    const source = store.createAgent(input("Source"), uuid(1));
    const target = store.createAgent(input("Target"), uuid(2));
    await expect(
      invoke(tool(service, source.id, 0), { agentId: source.id, task: "x" }),
    ).rejects.toThrow("another");
    store.updateAgent(target.id, { enabled: false });
    await expect(
      invoke(tool(service, source.id, 0), { agentId: target.id, task: "x" }),
    ).rejects.toThrow("enabled");
    store.close();
  });

  test("blocks recursive delegation and deduplicates a task id", async () => {
    const { store, service } = setup();
    const source = store.createAgent(input("Source", [uuid(2)]), uuid(1));
    const target = store.createAgent(input("Target"), uuid(2));
    const delegate = tool(service, source.id, 0);

    const first = await invoke(
      delegate,
      { agentId: target.id, task: "do it" },
      uuid(901),
      "same-task",
    );

    const second = await invoke(
      delegate,
      { agentId: target.id, task: "do it" },
      uuid(901),
      "same-task",
    );

    const firstReceipt = JSON.parse(first.output[0].text);
    const secondReceipt = JSON.parse(second.output[0].text);
    expect(secondReceipt.executionId).toBe(firstReceipt.executionId);
    expect(store.listExecutions(target.id)).toHaveLength(1);
    store.updateAgent(target.id, { delegates: [source.id] });
    expect(store.listExecutions(target.id)[0]!.conversationId).toBe(
      (await service.chat(target.id)).id,
    );
    await expect(
      invoke(
        tool(service, target.id, 0),
        { agentId: source.id, task: "nested" },
        uuid(903),
        "nested-task",
      ),
    ).rejects.toThrow("further delegations");
    store.close();
  });

  test("status receipts are source-scoped and revocation blocks access", async () => {
    const { store, service } = setup();
    const source = store.createAgent(input("Source", [uuid(2)]), uuid(1));
    const target = store.createAgent(input("Target"), uuid(2));
    const other = store.createAgent(input("Other", [target.id]), uuid(3));

    const result = await invoke(
      tool(service, source.id, 0),
      { agentId: target.id, task: "answer" },
      uuid(902),
      "status-task",
    );

    const executionId = JSON.parse(result.output[0].text).executionId;
    await expect(
      invoke(tool(service, other.id, 1), { executionId }),
    ).rejects.toThrow("receipt");
    const status = await invoke(tool(service, source.id, 1), { executionId });
    expect(JSON.parse(status.output[0].text)).toMatchObject({
      status: "running",
      response: [],
    });
    const granted = tool(service, source.id, 1);
    store.updateAgent(source.id, { tools: [] });
    await expect(invoke(granted, { executionId })).rejects.toThrow(
      "permission",
    );
    store.close();
  });
});

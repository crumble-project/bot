import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "./runtime";
import { standaloneBots } from "./bots";
import { Store } from "../../test/support/store";

const dirs: string[] = [];

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-recovery-"));
  dirs.push(dir);

  return dir;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const agentInput = {
  name: "Recovery",
  avatar: "sparkles",
  description: "",
  instructions: "",
  provider: "openai" as const,
  model: "gpt-4.1",
  enabled: true,
  tools: [],
  skills: [],
  mcpServers: [],
  delegates: [],
};

describe("scheduled admission recovery", () => {
  test("retries a failed admission after reopening while preserving one execution", async () => {
    const store = new Store(make());
    const agent = store.createAgent(agentInput);

    const schedule = store.createSchedule({
      agentId: agent.id,
      name: "Recovery task",
      prompt: "retry me",
      cron: null,
      timezone: "UTC",
      runAt: new Date(Date.now() + 60_000).toISOString(),
      enabled: true,
    });

    const conversationId = `${agent.id}:1`;
    let submissions = 0;

    const runtimeFixture = {
      openChat: async () => conversationId,
      submit: async () => {
        submissions += 1;

        if (submissions === 1) throw new Error("temporary runtime failure");

        return "1";
      },
      wait: async () => ({ status: "done" }),
      close: async () => undefined,
    };

    // SAFETY: The prototype supplies AgentRuntime identity; the fixture overrides dispatch methods used here.
    const fakeRuntime = Object.assign(
      Object.create(AgentRuntime.prototype),
      runtimeFixture,
    ) as AgentRuntime;

    const first = standaloneBots(store, fakeRuntime);
    await expect(
      first.dispatch(
        agent.id,
        schedule.prompt,
        `schedule:${schedule.id}:occurrence`,
        schedule.id,
      ),
    ).rejects.toThrow("temporary runtime failure");

    const second = standaloneBots(store, fakeRuntime);

    await second.dispatch(
      agent.id,
      schedule.prompt,
      `schedule:${schedule.id}:occurrence`,
      schedule.id,
    );

    expect(submissions).toBe(2);
    expect(store.listExecutions(agent.id)).toHaveLength(1);
    expect(store.listExecutions(agent.id)[0]?.submissionId).toBe("1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.listExecutions(agent.id)[0]?.status).toBe("done");
    await second.close();
    await first.close();
  });
});

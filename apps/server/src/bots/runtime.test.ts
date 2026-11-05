import { describe, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "./runtime";
import type { Agent } from "../contract/agents";
import { defaultAvatarDefinition } from "../contract/avatar";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";

const agent = (id: string, model = "test-model"): Agent => ({
  id,
  name: id,
  avatar: defaultAvatarDefinition(id),
  description: "",
  instructions: `You are ${id}`,
  // SAFETY: The faux provider is registered in the test model registry below.
  provider: "faux" as any,
  model,
  enabled: true,
  tools: ["memory"],
  skills: [],
  mcpServers: [],
  delegates: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe("AgentRuntime", () => {
  test("submits through a real durable harness and reopens", async () => {
    const dir = await Bun.$`mktemp -d`.text();

    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "test-model" }],
    });

    faux.setResponses([fauxAssistantMessage("hello")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const a = agent("00000000-0000-4000-8000-000000000001");
    const rt = new AgentRuntime(dir.trim(), runtimeCallbacks({ models }));
    const conversation = await rt.openChat(a);
    const submission = await rt.submit(a, conversation, "hi", "request-1");
    const settled = await rt.wait(submission, a);
    expect(settled.status).toBe("done");
    await rt.close();
    const reopened = new AgentRuntime(dir.trim(), runtimeCallbacks({ models }));
    const duplicate = await reopened.submit(a, conversation, "hi", "request-1");
    expect(duplicate).toBe(submission);
    const snapshot = await reopened.snapshot(a, conversation);
    expect(
      snapshot.messages.map(({ role, content }) => ({ role, content })),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    await reopened.close();
  });

  test("gives each bot only its own memory", async () => {
    const dir = await Bun.$`mktemp -d`.text();
    const models = createModels();

    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "test-model" }],
    });

    const ids = [
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ] as const;

    const remembered: string[][] = [];

    faux.setResponses(
      ids.map(() => (context) => {
        const sent = JSON.stringify(context.messages);
        remembered.push(ids.filter((id) => sent.includes(`memory of ${id}`)));

        return fauxAssistantMessage("ok");
      }),
    );
    models.setProvider(faux.provider);

    const rt = new AgentRuntime(
      dir.trim(),
      runtimeCallbacks({
        models,
        listMemory: async (id) => [{ id: "m", content: `memory of ${id}` }],
      }),
    );

    for (const id of ids) {
      const bot = agent(id);
      const conversation = await rt.openChat(bot);
      await rt.wait(await rt.submit(bot, conversation, "hi", `r-${id}`), bot);
    }

    expect(remembered).toEqual([[ids[0]], [ids[1]]]);
    await rt.close();
  });
});

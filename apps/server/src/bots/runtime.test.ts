import { describe, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "./runtime";
import type { Agent } from "../shared/domain";

const agent = (id: string, model = "test-model"): Agent => ({
  id,
  name: id,
  avatar: "sparkles",
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
    const rt = new AgentRuntime(dir.trim(), { models });
    const conversation = await rt.createConversation(a);
    const submission = await rt.submit(a, conversation, "hi", "request-1");
    const settled = await rt.wait(submission, a);
    expect(settled.status).toBe("done");
    await rt.close();
    const reopened = new AgentRuntime(dir.trim(), { models });
    const duplicate = await reopened.submit(a, conversation, "hi", "request-1");
    expect(duplicate).toBe(submission);
    const snapshot = await reopened.snapshot(a, conversation);
    expect(
      snapshot.messages.some((m) =>
        JSON.stringify(m.content).includes("hello"),
      ),
    ).toBe(true);
    await reopened.close();
  });

  test("isolates memory callbacks by agent", async () => {
    const dir = await Bun.$`mktemp -d`.text();
    const models = createModels();

    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "test-model" }],
    });

    models.setProvider(faux.provider);
    const seen: string[] = [];

    const rt = new AgentRuntime(dir.trim(), {
      models,
      listMemory: async (id) => {
        seen.push(id);

        return [{ id: "m", content: id }];
      },
    });

    for (const id of [
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ])
      await rt.createConversation(agent(id));
    expect(seen).toContain("00000000-0000-4000-8000-000000000002");
    expect(seen).toContain("00000000-0000-4000-8000-000000000003");
    await rt.close();
  });
});

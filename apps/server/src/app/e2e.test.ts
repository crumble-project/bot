import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../bots/runtime";
import { Store } from "../../test/support/store";
import { standaloneBots } from "../bots/bots";
import { standaloneScheduler } from "../automations/scheduler-test-support";
import { createAPI } from "./api";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";

const token = "e".repeat(40);
const requestId = "00000000-0000-4000-8000-000000000202";

describe("HTTP/runtime persistence", () => {
  test("submits through the real faux runtime and reopens the same chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-e2e-"));

    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "test-model" }],
    });

    faux.setResponses([fauxAssistantMessage("persisted hello")]);
    const models = createModels();
    models.setProvider(faux.provider);

    const makeApp = (store: Store, runtime: AgentRuntime) => {
      const service = standaloneBots(store, runtime);

      const scheduler = standaloneScheduler(store.runtime, (a, p, r, s) =>
        service.dispatch(a, p, r, s),
      );

      return createAPI(service, token, { scheduler });
    };

    try {
      const store = new Store(dir);

      const agent = store.createAgent({
        name: "Faux",
        description: "",
        instructions: "Answer",
        // SAFETY: The faux provider is registered in the test model registry.
        provider: "faux" as any,
        model: "test-model",
        enabled: true,
        tools: [],
        skills: [],
        mcpServers: [],
        delegates: [],
      });

      const runtime = new AgentRuntime(dir, runtimeCallbacks({ models }));
      const app = makeApp(store, runtime);

      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };

      const response = await app.request(`/v1/agents/${agent.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "hello", requestId }),
      });

      expect(response.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await response.json()).toMatchObject({
        agentId: agent.id,
        requestId,
        prompt: "hello",
        status: "running",
      });
      await runtime.close();
      store.close();

      const reopenedStore = new Store(dir);

      const reopenedRuntime = new AgentRuntime(
        dir,
        runtimeCallbacks({ models }),
      );

      const reopenedApp = makeApp(reopenedStore, reopenedRuntime);

      const snapshotResponse = await reopenedApp.request(
        `/v1/agents/${agent.id}/chat`,
        { headers },
      );

      expect(snapshotResponse.status).toBe(200);

      // SAFETY: the chat snapshot is narrowed to the message fields asserted below.
      const snapshot = (await snapshotResponse.json()) as {
        messages: { role: string; content: string }[];
      };

      expect(
        snapshot.messages.map(({ role, content }) => [role, content]),
      ).toEqual([
        ["user", "hello"],
        ["assistant", "persisted hello"],
      ]);
      await reopenedRuntime.close();
      reopenedStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

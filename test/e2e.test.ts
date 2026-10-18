import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../src/runtime";
import { Store } from "../src/store";
import { CrumbleService } from "../src/service";
import { Scheduler } from "../src/scheduler";
import { createAPI } from "../src/api";

const token = "e".repeat(40);
const agentId = "00000000-0000-4000-8000-000000000201";
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
      const service = new CrumbleService(store, runtime);
      const scheduler = new Scheduler(store, (a, p, r, s) =>
        service.dispatch(a, p, r, s),
      );
      return createAPI(service, scheduler, token);
    };
    try {
      const store = new Store(dir);
      const agent = store.createAgent({
        name: "Faux",
        avatar: "sparkles",
        description: "",
        instructions: "Answer",
        provider: "faux" as any,
        model: "test-model",
        enabled: true,
        folder: "Personal",
        tools: [],
        skills: [],
        mcpServers: [],
        delegates: [],
      });
      const runtime = new AgentRuntime(dir, { models });
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
      const execution: any = await response.json();
      expect(execution.status).toMatch(/running|done/);
      await runtime.close();
      store.close();

      const reopenedStore = new Store(dir);
      const reopenedRuntime = new AgentRuntime(dir, { models });
      const reopenedApp = makeApp(reopenedStore, reopenedRuntime);
      const snapshotResponse = await reopenedApp.request(
        `/v1/agents/${agent.id}/chat`,
        { headers },
      );
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json();
      expect(JSON.stringify(snapshot)).toContain("persisted hello");
      await reopenedRuntime.close();
      reopenedStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Store } from "../src/store";
import { AgentRuntime } from "../src/runtime";
import { CrumbleService } from "../src/service";

const agentId = "00000000-0000-4000-8000-000000000301";
const requestId = "00000000-0000-4000-8000-000000000302";

describe("crash recovery", () => {
  test("recovers durable execution and preserves one user turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-crash-"));
    const child = Bun.spawn(
      ["bun", "run", `${import.meta.dir}/fixtures/crash-server.ts`],
      {
        env: { ...process.env, BOT_CRASH_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = child.stdout.getReader();
      const ready = await Promise.race([
        reader
          .read()
          .then(({ value }) => (value ? new TextDecoder().decode(value) : "")),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("crash fixture timeout")), 10_000),
        ),
      ]);
      const metadata = JSON.parse(String(ready).trim()) as {
        agentId: string;
        conversationId: string;
        executionId: string;
      };
      expect(metadata.agentId).toBe(agentId);
      child.kill(9);
      await child.exited;

      const faux = fauxProvider({
        provider: "faux",
        models: [{ id: "crash-model" }],
      });
      faux.setResponses([fauxAssistantMessage("recovered response")]);
      const models = createModels();
      models.setProvider(faux.provider);
      const store = new Store(dir);
      const runtime = new AgentRuntime(dir, { models });
      const service = new CrumbleService(store, runtime);
      await service.recover();
      for (let i = 0; i < 20; i++) {
        if (store.getExecution(metadata.executionId)?.status === "done") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(store.getExecution(metadata.executionId)?.status).toBe("done");
      const snapshot = await runtime.snapshot(
        store.getAgent(agentId)!,
        metadata.conversationId,
      );
      expect(snapshot.messages.filter((m) => m.role === "user")).toHaveLength(
        1,
      );
      expect(JSON.stringify(snapshot)).toContain("recovered response");

      const second = store.createAgent(
        {
          name: "Second",
          avatar: "sparkles",
          description: "",
          instructions: "",
          provider: "faux" as any,
          model: "crash-model",
          enabled: true,
          folder: "Personal",
          tools: [],
          skills: [],
          mcpServers: [],
          delegates: [],
        },
        "00000000-0000-4000-8000-000000000303",
      );
      const firstConversation = await runtime.createConversation(
        store.getAgent(agentId)!,
      );
      const secondConversation = await runtime.createConversation(second);
      expect(firstConversation).not.toBe(secondConversation);
      await runtime.close();
      store.close();
    } finally {
      if (!child.killed) child.kill(9);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

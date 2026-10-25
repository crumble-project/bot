import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { AgentRepository } from "../bots/agent-repository";
import { standaloneGroupChats } from "../group-chats/group-chats";
import { GroupTranscripts } from "../group-chats/group-transcripts";
import { HistorySearch } from "./history-search";
import { historySource } from "./history-tools";
import { AgentRuntime } from "../bots/runtime";
import { standaloneBots } from "../bots/bots";
import { Store } from "../shared/store";

test("history search keeps committed assistant messages visible across turn completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-history-active-"));
  const waiting = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses([
    fauxAssistantMessage(
      [fauxText("retained sentinel"), fauxToolCall("probe", {})],
      { stopReason: "toolUse" },
    ),
    async () => {
      waiting.resolve();
      await finish.promise;

      return fauxAssistantMessage("Finished.");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new Store(dir);

  const runtime = new AgentRuntime(join(dir, "agents"), {
    models,
    extensions: () => [
      defineExtension({
        name: "probe",
        tools: [
          defineTool({
            name: "probe",
            description: "Return a result.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async () => ({
              output: [{ type: "text" as const, text: "Done." }],
            }),
          }),
        ],
      }),
    ],
  });

  const service = standaloneBots(store, runtime);

  const groups = standaloneGroupChats(
    service,
    new GroupTranscripts(join(dir, "groups")),
  );

  try {
    const agent = store.createAgent({
      name: "Ada",
      avatar: "bot",
      description: "",
      instructions: "Answer",
      provider: "faux",
      model: "chat",
      enabled: true,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    });

    const engine = new HistorySearch(
      historySource(
        runtime,
        store.runtime.runSync(AgentRepository.use(Effect.succeed)),
        groups.service,
      ),
    );

    const context = { agentId: agent.id, groupId: null };
    const chat = await runtime.openChat(agent);
    const submission = await runtime.submit(agent, chat, "Run the probe.");
    await waiting.promise;
    const active = await engine.search(context, { query: "retained sentinel" });
    expect(active.matches).toHaveLength(1);

    const before = await engine.read(context, {
      match: active.matches[0]!.match,
    });

    finish.resolve();
    await runtime.wait(submission, agent);

    const after = await engine.read(context, {
      match: active.matches[0]!.match,
    });

    expect(after.messages).toEqual(before.messages);
    expect(after.omittedToolActivity).toBe(true);
  } finally {
    finish.resolve();
    await groups.close();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

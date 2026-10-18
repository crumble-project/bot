import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../src/runtime";
import { CrumbleService } from "../src/service";
import { Store } from "../src/store";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function open(dir: string, responses: FauxResponseStep[]) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new Store(dir);
  const service = new CrumbleService(
    store,
    new AgentRuntime(dir, { models }),
  );
  return { store, service };
}

function setup(responses: FauxResponseStep[]) {
  const dir = mkdtempSync(join(tmpdir(), "bot-chat-"));
  dirs.push(dir);
  const opened = open(dir, responses);
  const agent = opened.store.createAgent({
    name: "Chat",
    avatar: "bot",
    description: "",
    instructions: "Answer",
    provider: "faux",
    model: "chat",
    enabled: true,
    folder: "Personal",
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });
  return { ...opened, dir, agent };
}

async function settle(service: CrumbleService, executionId: string) {
  for (let i = 0; i < 200; i++) {
    const status = service.store.getExecution(executionId)?.status;
    if (status !== "pending" && status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Execution did not settle");
}

describe("continuous bot chat", () => {
  test("keeps the full transcript visible after compaction", async () => {
    const { service, agent } = setup([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
      fauxAssistantMessage("Summary of earlier work"),
    ]);
    // Pi keeps the newest 20k tokens verbatim, so only a long latest turn leaves older turns to summarize.
    const long = `second question ${"word ".repeat(25000)}`;
    for (const [index, text] of ["first question", long].entries())
      await settle(
        service,
        (await service.sendChat(agent.id, text, uuid(index + 1))).id,
      );
    await service.compact(agent.id);
    let transcript = (await service.chatSnapshot(agent.id)).messages;
    for (let i = 0; i < 200 && transcript.at(-1)?.kind !== "compaction"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      transcript = (await service.chatSnapshot(agent.id)).messages;
    }
    expect(transcript.at(-1)?.kind).toBe("compaction");
    expect(transcript.at(-1)?.content).toContain("Summary of earlier work");
    expect(transcript.map((message) => message.content)).toEqual([
      "first question",
      "first answer",
      long,
      "second answer",
      transcript.at(-1)!.content,
    ]);
    await service.close();
  });

  test("pages older history without splitting or repeating entries", async () => {
    const { service, agent } = setup(
      Array.from({ length: 3 }, (_, i) => fauxAssistantMessage(`answer ${i}`)),
    );
    for (let i = 0; i < 3; i++)
      await settle(
        service,
        (await service.sendChat(agent.id, `question ${i}`, uuid(i + 1))).id,
      );
    const seen: string[] = [];
    let page = await service.history(agent.id, { limit: 2 });
    seen.unshift(...page.messages.map((message) => message.id));
    while (page.hasMore && page.oldestEntryId) {
      page = await service.history(agent.id, {
        before: page.oldestEntryId,
        limit: 2,
      });
      seen.unshift(...page.messages.map((message) => message.id));
    }
    const all = (await service.history(agent.id, { limit: 200 })).messages;
    expect(seen).toEqual(all.map((message) => message.id));
    expect(all.filter((message) => message.role === "user")).toHaveLength(3);
    await service.close();
  });

  test("a reply sends bounded context once and displays the original text", async () => {
    const requests: string[] = [];
    const record: FauxResponseStep = (context) => {
      requests.push(JSON.stringify(context.messages.at(-1)));
      return fauxAssistantMessage("noted");
    };
    const { service, agent } = setup([record, record, record]);
    await settle(
      service,
      (await service.sendChat(agent.id, "x".repeat(20000), uuid(1))).id,
    );
    await settle(
      service,
      (await service.sendChat(agent.id, "unrelated", uuid(2))).id,
    );
    const target = (await service.chatSnapshot(agent.id)).messages.find(
      (message) => message.role === "user" && message.content.startsWith("x"),
    )!;
    const reply = await service.sendChat(
      agent.id,
      "expand on this",
      uuid(3),
      target.entryId,
    );
    await settle(service, reply.id);
    expect(requests[2]).toContain("reply_context");
    expect(requests[2]).toContain("expand on this");
    expect(requests[2]!.length).toBeLessThan(14000);
    const shown = (await service.chatSnapshot(agent.id)).messages.find(
      (message) => message.replyTo === target.entryId,
    )!;
    expect(shown.content).toBe("expand on this");
    expect(shown.replyPreview).toBe("x".repeat(240));
    await expect(
      service.sendChat(agent.id, "bad", uuid(4), "other-agent:1"),
    ).rejects.toThrow("different agent");
    await service.close();
  });

  test("restarts keep one chat and one durable input per request", async () => {
    const { service, agent, dir } = setup([fauxAssistantMessage("once")]);
    const chat = await service.chat(agent.id);
    const first = await service.sendChat(agent.id, "hello", uuid(1));
    await settle(service, first.id);
    await service.close();
    const reopened = open(dir, [fauxAssistantMessage("never")]);
    expect((await reopened.service.chat(agent.id)).id).toBe(chat.id);
    const again = await reopened.service.sendChat(agent.id, "hello", uuid(1));
    expect(again.id).toBe(first.id);
    const users = (await reopened.service.chatSnapshot(agent.id)).messages.filter(
      (message) => message.role === "user",
    );
    expect(users.map((message) => message.content)).toEqual(["hello"]);
    await reopened.service.close();
  });
});
